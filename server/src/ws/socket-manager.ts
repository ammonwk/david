// ============================================
// David — AI SRE Tool
// Socket.IO WebSocket Manager
// ============================================

import { Server as HTTPServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import type {
  WSEventType,
  AgentEventData,
  ScanEventData,
  BugEventData,
  PREventData,
  PoolStatusData,
  TopologyEventData,
  AuditEventData,
  ActivityEvent,
} from 'david-shared';

const MAX_ACTIVITY_LOG = 200;

/**
 * Generate a human-readable message from a WebSocket event.
 */
function buildActivityMessage(eventType: WSEventType, data: unknown): string {
  switch (eventType) {
    // Scan events
    case 'scan:started': {
      const d = data as ScanEventData;
      return `Log scan started (${d.config.timeSpan}, severity: ${d.config.severity})`;
    }
    case 'scan:completed': {
      const d = data as ScanEventData;
      return `Log scan completed (${d.config.timeSpan})`;
    }
    case 'scan:failed': {
      const d = data as ScanEventData & { error: string };
      return `Log scan failed: ${d.error}`;
    }

    // Agent events
    case 'agent:queued': {
      const d = data as AgentEventData;
      return `${d.type} agent ${d.agentId.slice(0, 8)} queued`;
    }
    case 'agent:started': {
      const d = data as AgentEventData;
      return `${d.type} agent ${d.agentId.slice(0, 8)} started`;
    }
    case 'agent:output': {
      const d = data as AgentEventData;
      return `${d.type} agent ${d.agentId.slice(0, 8)} output`;
    }
    case 'agent:completed': {
      const d = data as AgentEventData;
      return `${d.type} agent ${d.agentId.slice(0, 8)} completed`;
    }
    case 'agent:failed': {
      const d = data as AgentEventData;
      return `${d.type} agent ${d.agentId.slice(0, 8)} failed`;
    }
    case 'agent:timeout': {
      const d = data as AgentEventData;
      return `${d.type} agent ${d.agentId.slice(0, 8)} timed out`;
    }
    case 'agent:restarted': {
      const d = data as AgentEventData;
      return `${d.type} agent ${d.agentId.slice(0, 8)} restarted`;
    }

    // Bug events
    case 'bug:reported': {
      const d = data as BugEventData;
      return `Bug reported: ${d.pattern} (${d.severity})`;
    }
    case 'bug:verified': {
      const d = data as BugEventData;
      return `Bug verified: ${d.pattern}`;
    }
    case 'bug:fixed': {
      const d = data as BugEventData;
      return `Bug fixed: ${d.pattern}`;
    }

    // PR events
    case 'pr:created': {
      const d = data as PREventData;
      return `PR #${d.prNumber} created: ${d.title}`;
    }
    case 'pr:merged': {
      const d = data as PREventData;
      return `PR #${d.prNumber} merged: ${d.title}`;
    }
    case 'pr:closed': {
      const d = data as PREventData;
      return `PR #${d.prNumber} closed: ${d.title}`;
    }

    // Pool events
    case 'pool:status-update': {
      const d = data as PoolStatusData;
      return `Agent pool: ${d.activeCount}/${d.maxConcurrent} active, ${d.queuedCount} queued`;
    }

    // Topology events
    case 'topology:mapping-started': {
      return 'Codebase topology mapping started';
    }
    case 'topology:mapping-completed': {
      const d = data as TopologyEventData;
      return `Codebase topology mapping completed (${d.nodeCount ?? 0} nodes, ${d.fileCount ?? 0} files)`;
    }

    // Audit events
    case 'audit:started': {
      const d = data as AuditEventData;
      return `Codebase audit started (${d.agentCount} agents, ${d.nodeIds.length} nodes)`;
    }
    case 'audit:completed': {
      const d = data as AuditEventData;
      return `Codebase audit completed (${d.agentCount} agents)`;
    }

    default:
      return `Event: ${eventType}`;
  }
}

/**
 * Determine a severity level for the activity feed based on the event type.
 */
function getSeverity(eventType: WSEventType): ActivityEvent['severity'] {
  switch (eventType) {
    case 'scan:failed':
    case 'agent:failed':
    case 'agent:timeout':
      return 'error';

    case 'agent:restarted':
      return 'warning';

    case 'scan:completed':
    case 'agent:completed':
    case 'bug:fixed':
    case 'pr:merged':
    case 'topology:mapping-completed':
    case 'audit:completed':
      return 'success';

    default:
      return 'info';
  }
}

/**
 * Manages all WebSocket communication for the David SRE dashboard.
 *
 * Singleton — import the pre-instantiated `socketManager` export.
 */
class SocketManager {
  private io: SocketIOServer | null = null;
  private activityLog: ActivityEvent[] = [];

  /** Maps source entity IDs (scanId, bugId, agentId, prId) → most recent ActivityEvent ID */
  private entityToEventId = new Map<string, string>();
  private static readonly MAX_ENTITY_MAP_SIZE = 1000;

  // ------------------------------------------------
  // Lifecycle
  // ------------------------------------------------

  /**
   * Attach Socket.IO to an existing HTTP server and begin accepting
   * connections.
   */
  init(server: HTTPServer): void {
    this.io = new SocketIOServer(server, {
      cors: {
        origin: config.nodeEnv === 'development' ? '*' : undefined,
        methods: ['GET', 'POST'],
      },
    });

    this.io.on('connection', (socket: Socket) => {
      // Every client joins the dashboard room by default
      socket.join('dashboard');

      // Send recent activity history to the newly connected client
      socket.emit('activity:history', this.activityLog);

      // Allow clients to subscribe to live agent output
      socket.on('agent:watch', (agentId: string) => {
        if (typeof agentId === 'string' && agentId.length > 0) {
          socket.join(`agent:${agentId}`);
        }
      });

      socket.on('agent:unwatch', (agentId: string) => {
        if (typeof agentId === 'string' && agentId.length > 0) {
          socket.leave(`agent:${agentId}`);
        }
      });

      // Handle reconnection sync — resend activity history so the client
      // can catch up on any events missed while disconnected.
      socket.on('sync:request', () => {
        socket.emit('activity:history', this.activityLog);
      });
    });
  }

  // ------------------------------------------------
  // Core broadcast helpers
  // ------------------------------------------------

  /**
   * Broadcast an event to all connected clients and record it in the
   * activity log ring buffer.
   *
   * @param sourceId      - The entity ID that this event represents (e.g. scanId, bugId).
   * @param parentSourceId - The entity ID of the parent that caused this event (e.g. scanId for a bug).
   */
  broadcast(eventType: WSEventType, data: unknown, sourceId?: string, parentSourceId?: string): void {
    if (!this.io) return;

    // Emit the typed event to all dashboard clients
    this.io.to('dashboard').emit(eventType, data);

    // Skip agent:output from the activity log — it would flood the feed
    if (eventType === 'agent:output') return;

    const activity: ActivityEvent = {
      id: randomUUID(),
      type: eventType,
      message: buildActivityMessage(eventType, data),
      timestamp: new Date(),
      severity: getSeverity(eventType),
      sourceId,
      parentId: parentSourceId ? this.entityToEventId.get(parentSourceId) : undefined,
    };

    // Track this event's ID so future child events can reference it
    if (sourceId) {
      // Simple LRU eviction: if at capacity, delete the oldest (first) key
      if (this.entityToEventId.size >= SocketManager.MAX_ENTITY_MAP_SIZE) {
        const firstKey = this.entityToEventId.keys().next().value;
        if (firstKey !== undefined) {
          this.entityToEventId.delete(firstKey);
        }
      }
      this.entityToEventId.set(sourceId, activity.id);
    }

    // Ring buffer — drop the oldest event when at capacity
    if (this.activityLog.length >= MAX_ACTIVITY_LOG) {
      this.activityLog.shift();
    }
    this.activityLog.push(activity);

    // Push the new activity item to every connected client
    this.io.to('dashboard').emit('activity:new', activity);
  }

  /**
   * Broadcast a line of output to clients watching a specific agent.
   */
  broadcastAgentOutput(agentId: string, line: string): void {
    if (!this.io) return;
    this.io.to(`agent:${agentId}`).emit('agent:output', { agentId, line });
  }

  // ------------------------------------------------
  // Scan helpers
  // ------------------------------------------------

  emitScanStarted(data: ScanEventData): void {
    this.broadcast('scan:started', data, data.scanId);
  }

  emitScanCompleted(data: ScanEventData): void {
    this.broadcast('scan:completed', data, data.scanId);
  }

  emitScanFailed(data: ScanEventData & { error: string }): void {
    this.broadcast('scan:failed', data, data.scanId);
  }

  // ------------------------------------------------
  // Agent helpers
  // ------------------------------------------------

  emitAgentQueued(data: AgentEventData): void {
    this.broadcast('agent:queued', data, data.agentId);
  }

  emitAgentStarted(data: AgentEventData): void {
    this.broadcast('agent:started', data, data.agentId);
  }

  emitAgentOutput(data: AgentEventData): void {
    this.broadcast('agent:output', data, data.agentId);
  }

  emitAgentCompleted(data: AgentEventData): void {
    this.broadcast('agent:completed', data, data.agentId);
  }

  emitAgentFailed(data: AgentEventData): void {
    this.broadcast('agent:failed', data, data.agentId);
  }

  emitAgentTimeout(data: AgentEventData): void {
    this.broadcast('agent:timeout', data, data.agentId);
  }

  emitAgentRestarted(data: AgentEventData): void {
    this.broadcast('agent:restarted', data, data.agentId);
  }

  // ------------------------------------------------
  // Bug helpers
  // ------------------------------------------------

  emitBugReported(data: BugEventData, parentSourceId?: string): void {
    this.broadcast('bug:reported', data, data.bugId, parentSourceId);
  }

  emitBugVerified(data: BugEventData, parentSourceId?: string): void {
    this.broadcast('bug:verified', data, data.bugId, parentSourceId);
  }

  emitBugFixed(data: BugEventData, parentSourceId?: string): void {
    this.broadcast('bug:fixed', data, data.bugId, parentSourceId);
  }

  // ------------------------------------------------
  // PR helpers
  // ------------------------------------------------

  emitPRCreated(data: PREventData, parentSourceId?: string): void {
    this.broadcast('pr:created', data, data.prId, parentSourceId);
  }

  emitPRMerged(data: PREventData, parentSourceId?: string): void {
    this.broadcast('pr:merged', data, data.prId, parentSourceId);
  }

  emitPRClosed(data: PREventData, parentSourceId?: string): void {
    this.broadcast('pr:closed', data, data.prId, parentSourceId);
  }

  // ------------------------------------------------
  // Pool / Topology / Audit helpers
  // ------------------------------------------------

  emitPoolStatus(data: PoolStatusData): void {
    this.broadcast('pool:status-update', data);
  }

  emitTopologyMappingStarted(data: TopologyEventData): void {
    this.broadcast('topology:mapping-started', data, data.topologyId);
  }

  emitTopologyMappingCompleted(data: TopologyEventData): void {
    this.broadcast('topology:mapping-completed', data, data.topologyId);
  }

  emitAuditStarted(data: AuditEventData): void {
    this.broadcast('audit:started', data, data.auditId);
  }

  emitAuditCompleted(data: AuditEventData): void {
    this.broadcast('audit:completed', data, data.auditId);
  }

  // ------------------------------------------------
  // Queries
  // ------------------------------------------------

  /**
   * Return the recent activity log (up to 200 events) for hydrating a
   * newly connected client.
   */
  getRecentActivity(): ActivityEvent[] {
    return this.activityLog;
  }

  /**
   * Return the current number of connected sockets.
   */
  getConnectionCount(): number {
    if (!this.io) return 0;
    return this.io.engine.clientsCount;
  }
}

export const socketManager = new SocketManager();
