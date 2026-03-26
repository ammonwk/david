// ============================================
// David — AI SRE Tool
// Codebase Mapper Engine
//
// Discovers the L1/L2/L3 topology of the target
// codebase using LLM calls (Gemini via OpenRouter).
// Persists results to MongoDB for use by audit
// agents and the dashboard treemap.
// ============================================

import { execSync } from 'child_process';
import { walkRepo, formatTreeForLLM, readFileHead } from './filesystem-walker.js';
import type { FileInfo, WalkResult } from './filesystem-walker.js';
import { completeWithGeminiPro, completeWithGeminiFlash } from '../llm/openrouter.js';
import { buildL1DiscoveryPrompt, buildL2DiscoveryPrompt, buildL3DiscoveryPrompt } from '../agents/prompts.js';
import { CodebaseTopologyModel } from '../db/models.js';
import { socketManager } from '../ws/socket-manager.js';
import { createSnapshotWorktree, removeWorktreeByPath } from '../agents/worktree-manager.js';
import { ensureControlRepo } from '../repo/repo-manager.js';
import type { TopologyNode, CodebaseTopology } from 'david-shared';

// ---------------------------------------------------------------------------
// Types — LLM response shapes
// ---------------------------------------------------------------------------

interface L1Group {
  name: string;
  description: string;
  includes: string[];
}

interface L2Group {
  name: string;
  description: string;
  includes: string[];
}

interface L3Group {
  name: string;
  description: string;
  files: string[];
}

// ---------------------------------------------------------------------------
// CodebaseMapper
// ---------------------------------------------------------------------------

export class CodebaseMapper {

  // ------------------------------------------------------------------
  // Run the full mapping pipeline
  // ------------------------------------------------------------------

  async mapCodebase(): Promise<string> {
    console.log('[CodebaseMapper] Starting codebase mapping pipeline');
    const repo = await ensureControlRepo(true);
    const snapshot = await createSnapshotWorktree(`map-${Date.now()}`);

    try {
      // 1. Emit topology:mapping-started
      socketManager.emitTopologyMappingStarted({
        topologyId: '',  // Will be set once persisted
      });

      // 2. Phase 1: Filesystem walk
      console.log('[CodebaseMapper] Phase 1: Walking filesystem...');
      const walkResult = await walkRepo(snapshot.path);
      const treeText = formatTreeForLLM(walkResult.tree);

      console.log(
        `[CodebaseMapper] Walk complete: ${walkResult.totalFiles} files, ` +
        `${walkResult.totalLines.toLocaleString()} lines`,
      );

      // 3. Get current git commit hash
      let commitHash: string;
      try {
        commitHash = execSync('git rev-parse HEAD', {
          cwd: snapshot.path,
          encoding: 'utf-8',
        }).trim();
      } catch {
        console.warn('[CodebaseMapper] Could not get git commit hash, using "unknown"');
        commitHash = 'unknown';
      }

      // 4. Phase 2: L1 Discovery (single gemini-pro call)
      console.log('[CodebaseMapper] Phase 2: L1 Discovery...');
      const l1Groups = await this.discoverL1(treeText);
      console.log(`[CodebaseMapper] L1 complete: ${l1Groups.length} groups`);

      const allNodes: TopologyNode[] = [];

      // Create L1 topology nodes
      const l1Nodes: TopologyNode[] = l1Groups.map((group) => {
        const matchedFiles = this.matchFilesToGroup(walkResult.files, group.includes);
        const totalLines = matchedFiles.reduce((sum, f) => sum + f.lines, 0);

        return {
          id: this.generateNodeId(1, group.name),
          name: group.name,
          description: group.description,
          level: 1 as const,
          parentId: null,
          files: matchedFiles.map((f) => f.relativePath),
          totalLines,
          children: [],
        };
      });

      allNodes.push(...l1Nodes);

      // 5. Phase 3: L2 Discovery (parallel gemini-flash calls)
      console.log('[CodebaseMapper] Phase 3: L2 Discovery...');
      const l2Results = await Promise.all(
        l1Nodes.map(async (l1Node, idx) => {
          try {
            return await this.discoverL2(l1Node, l1Groups[idx], walkResult.files);
          } catch (err) {
            console.error(
              `[CodebaseMapper] L2 discovery failed for "${l1Node.name}":`,
              err instanceof Error ? err.message : err,
            );
            return [];
          }
        }),
      );

    const allL2Nodes: TopologyNode[] = [];

    for (let i = 0; i < l1Nodes.length; i++) {
      const l1Node = l1Nodes[i];
      const l2Groups = l2Results[i];

      const l2Nodes: TopologyNode[] = l2Groups.map((group) => {
        const matchedFiles = this.matchFilesToGroup(walkResult.files, group.includes);
        const totalLines = matchedFiles.reduce((sum, f) => sum + f.lines, 0);

        return {
          id: this.generateNodeId(2, group.name, l1Node.id),
          name: group.name,
          description: group.description,
          level: 2 as const,
          parentId: l1Node.id,
          files: matchedFiles.map((f) => f.relativePath),
          totalLines,
          children: [],
        };
      });

      // Wire L1 children
      l1Node.children = l2Nodes.map((n) => n.id);
      allL2Nodes.push(...l2Nodes);
    }

    allNodes.push(...allL2Nodes);
    console.log(`[CodebaseMapper] L2 complete: ${allL2Nodes.length} groups`);

    // 6. Phase 4: L3 Discovery (parallel gemini-flash calls)
    console.log('[CodebaseMapper] Phase 4: L3 Discovery...');
    const l3Results = await Promise.all(
      allL2Nodes.map(async (l2Node) => {
        try {
          return await this.discoverL3(l2Node, walkResult.files);
        } catch (err) {
          console.error(
            `[CodebaseMapper] L3 discovery failed for "${l2Node.name}":`,
            err instanceof Error ? err.message : err,
          );
          return [];
        }
      }),
    );

    const allL3Nodes: TopologyNode[] = [];

    for (let i = 0; i < allL2Nodes.length; i++) {
      const l2Node = allL2Nodes[i];
      const l3Groups = l3Results[i];

      const l3Nodes: TopologyNode[] = l3Groups.map((group) => {
        const totalLines = walkResult.files
          .filter((f) => group.files.includes(f.relativePath))
          .reduce((sum, f) => sum + f.lines, 0);

        return {
          id: this.generateNodeId(3, group.name, l2Node.id),
          name: group.name,
          description: group.description,
          level: 3 as const,
          parentId: l2Node.id,
          files: group.files,
          totalLines,
          children: [],
        };
      });

      // Wire L2 children
      l2Node.children = l3Nodes.map((n) => n.id);
      allL3Nodes.push(...l3Nodes);
    }

    allNodes.push(...allL3Nodes);
    console.log(`[CodebaseMapper] L3 complete: ${allL3Nodes.length} groups`);

    // 7. Phase 5: Persist to MongoDB
    console.log('[CodebaseMapper] Phase 5: Persisting topology...');
      const topologyDoc = await CodebaseTopologyModel.create({
        mappedAt: new Date(),
        commitHash,
        repoPath: repo.controlRepoPath,
        fileCount: walkResult.totalFiles,
        totalLines: walkResult.totalLines,
        nodes: allNodes,
      });

      const topologyId = topologyDoc._id.toString();

      console.log(
        `[CodebaseMapper] Topology persisted: id=${topologyId}, ` +
        `${allNodes.length} nodes (${l1Nodes.length} L1, ${allL2Nodes.length} L2, ${allL3Nodes.length} L3)`,
      );

      // 8. Emit topology:mapping-completed
      socketManager.emitTopologyMappingCompleted({
        topologyId,
        nodeCount: allNodes.length,
        fileCount: walkResult.totalFiles,
      });

      return topologyId;
    } finally {
      await removeWorktreeByPath(snapshot.path, snapshot.branch).catch((err) => {
        console.warn(
          `[CodebaseMapper] Failed to clean up snapshot worktree ${snapshot.path}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
  }

  // ------------------------------------------------------------------
  // Get the latest topology from MongoDB
  // ------------------------------------------------------------------

  async getLatestTopology(): Promise<CodebaseTopology | null> {
    return CodebaseTopologyModel.getLatest() as unknown as CodebaseTopology | null;
  }

  // ------------------------------------------------------------------
  // L1 Discovery
  // ------------------------------------------------------------------

  private async discoverL1(treeText: string): Promise<L1Group[]> {
    const prompt = buildL1DiscoveryPrompt(treeText);
    const result = await completeWithGeminiPro(
      [{ role: 'user', content: prompt }],
      { temperature: 0.2, maxTokens: 8192 },
    );

    const groups = this.parseJSONResponse<L1Group[]>(result.content);

    if (!Array.isArray(groups)) {
      throw new Error('[CodebaseMapper] L1 response is not a JSON array');
    }

    // Validate shape
    for (const group of groups) {
      if (!group.name || !group.description || !Array.isArray(group.includes)) {
        throw new Error(
          `[CodebaseMapper] Invalid L1 group shape: ${JSON.stringify(group).slice(0, 200)}`,
        );
      }
    }

    return groups;
  }

  // ------------------------------------------------------------------
  // L2 Discovery
  // ------------------------------------------------------------------

  private async discoverL2(
    l1Node: TopologyNode,
    l1Group: L1Group,
    allFiles: FileInfo[],
  ): Promise<L2Group[]> {
    const matchedFiles = this.matchFilesToGroup(allFiles, l1Group.includes);

    // If too few files, skip L2 splitting — create a single pass-through group
    if (matchedFiles.length <= 5) {
      return [{
        name: l1Node.name,
        description: l1Node.description,
        includes: l1Group.includes,
      }];
    }

    const fileList = matchedFiles
      .map((f) => `  ${f.relativePath} (${f.lines} lines)`)
      .join('\n');

    const prompt = buildL2DiscoveryPrompt(l1Group.name, l1Group.description, fileList);
    const result = await completeWithGeminiFlash(
      [{ role: 'user', content: prompt }],
      { temperature: 0.2, maxTokens: 4096 },
    );

    const groups = this.parseJSONResponse<L2Group[]>(result.content);

    if (!Array.isArray(groups)) {
      throw new Error(`[CodebaseMapper] L2 response for "${l1Node.name}" is not a JSON array`);
    }

    // Validate shape
    for (const group of groups) {
      if (!group.name || !group.description || !Array.isArray(group.includes)) {
        throw new Error(
          `[CodebaseMapper] Invalid L2 group shape: ${JSON.stringify(group).slice(0, 200)}`,
        );
      }
    }

    return groups;
  }

  // ------------------------------------------------------------------
  // L3 Discovery
  // ------------------------------------------------------------------

  private async discoverL3(
    l2Node: TopologyNode,
    allFiles: FileInfo[],
  ): Promise<L3Group[]> {
    // Get the files that belong to this L2 node
    const l2Files = allFiles.filter((f) => l2Node.files.includes(f.relativePath));

    // If too few files, create a single L3 group wrapping all of them
    if (l2Files.length <= 5) {
      return [{
        name: l2Node.name,
        description: l2Node.description,
        files: l2Files.map((f) => f.relativePath),
      }];
    }

    // Build file list with previews (first 50 lines of each file)
    const previews = await Promise.all(
      l2Files.map(async (f) => {
        const head = await readFileHead(f.absolutePath, 50);
        return (
          `--- ${f.relativePath} (${f.lines} lines) ---\n` +
          head +
          '\n'
        );
      }),
    );

    const fileListWithPreviews = previews.join('\n');

    const prompt = buildL3DiscoveryPrompt(l2Node.name, l2Node.description, fileListWithPreviews);
    const result = await completeWithGeminiFlash(
      [{ role: 'user', content: prompt }],
      { temperature: 0.2, maxTokens: 4096 },
    );

    const groups = this.parseJSONResponse<L3Group[]>(result.content);

    if (!Array.isArray(groups)) {
      throw new Error(`[CodebaseMapper] L3 response for "${l2Node.name}" is not a JSON array`);
    }

    // Validate shape
    for (const group of groups) {
      if (!group.name || !group.description || !Array.isArray(group.files)) {
        throw new Error(
          `[CodebaseMapper] Invalid L3 group shape: ${JSON.stringify(group).slice(0, 200)}`,
        );
      }
    }

    return groups;
  }

  // ------------------------------------------------------------------
  // Parse LLM response that should contain JSON
  // ------------------------------------------------------------------

  private parseJSONResponse<T = unknown>(response: string): T {
    // Strategy 1: Try to extract from a ```json ... ``` fenced block
    const fencedMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fencedMatch) {
      try {
        return JSON.parse(this.sanitizeJSON(fencedMatch[1].trim()));
      } catch {
        // Fall through to next strategy
      }
    }

    // Strategy 2: Try to find the first [ or { and parse from there
    const firstBracket = response.search(/[\[{]/);
    if (firstBracket !== -1) {
      // Find the matching closing bracket
      const openChar = response[firstBracket];
      const closeChar = openChar === '[' ? ']' : '}';
      let depth = 0;
      let lastBracket = -1;

      for (let i = firstBracket; i < response.length; i++) {
        if (response[i] === openChar) depth++;
        if (response[i] === closeChar) {
          depth--;
          if (depth === 0) {
            lastBracket = i;
            break;
          }
        }
      }

      if (lastBracket !== -1) {
        const jsonStr = response.slice(firstBracket, lastBracket + 1);
        try {
          return JSON.parse(this.sanitizeJSON(jsonStr));
        } catch {
          // Fall through to raw parse
        }
      }
    }

    // Strategy 3: Try parsing the entire response as-is
    try {
      return JSON.parse(this.sanitizeJSON(response.trim()));
    } catch {
      throw new Error(
        `[CodebaseMapper] Failed to parse JSON from LLM response. ` +
        `First 500 chars: ${response.slice(0, 500)}`,
      );
    }
  }

  // ------------------------------------------------------------------
  // Sanitize common LLM JSON issues
  // ------------------------------------------------------------------

  private sanitizeJSON(json: string): string {
    // Remove trailing commas before closing brackets/braces
    // e.g., [1, 2, 3,] → [1, 2, 3]
    return json.replace(/,\s*([}\]])/g, '$1');
  }

  // ------------------------------------------------------------------
  // Generate a slug ID for a node
  // ------------------------------------------------------------------

  private generateNodeId(level: number, name: string, parentId?: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const base = `l${level}-${slug}`;

    // Append a suffix from the parent to avoid collisions across different
    // parents that have sub-groups with the same name
    if (parentId) {
      // Extract the parent slug portion (after "lN-")
      const parentSlug = parentId.replace(/^l\d+-/, '');
      // Use the first 8 characters of the parent slug for compactness
      return `${base}--${parentSlug.slice(0, 8)}`;
    }

    return base;
  }

  // ------------------------------------------------------------------
  // Match files to a group's includes prefixes
  // ------------------------------------------------------------------

  private matchFilesToGroup(
    files: FileInfo[],
    includes: string[],
  ): FileInfo[] {
    return files.filter((f) =>
      includes.some((prefix) =>
        prefix.endsWith('/')
          ? f.relativePath.startsWith(prefix)
          : f.relativePath === prefix || f.relativePath.startsWith(prefix + '/'),
      ),
    );
  }

  // ------------------------------------------------------------------
  // Build a topology summary string (for agent prompts)
  // ------------------------------------------------------------------

  async getTopologySummary(): Promise<string> {
    const topology = await this.getLatestTopology();
    if (!topology) return 'No codebase topology available yet.';

    const lines: string[] = [];
    lines.push(
      `Codebase topology (mapped ${topology.mappedAt.toISOString()}, ` +
      `commit ${topology.commitHash.slice(0, 8)}, ` +
      `${topology.fileCount} files, ` +
      `${topology.totalLines.toLocaleString()} lines):`,
    );
    lines.push('');

    // Index nodes by id for quick lookup
    const nodeById = new Map<string, TopologyNode>();
    for (const node of topology.nodes) {
      nodeById.set(node.id, node);
    }

    // Render L1 nodes and their descendants
    const l1Nodes = topology.nodes.filter((n) => n.level === 1);

    for (const l1 of l1Nodes) {
      lines.push(
        `L1: ${l1.name} (${l1.files.length} files, ${l1.totalLines.toLocaleString()} lines)`,
      );

      // L2 children
      for (const l2Id of l1.children) {
        const l2 = nodeById.get(l2Id);
        if (!l2) continue;

        lines.push(
          `  L2: ${l2.name} (${l2.files.length} files, ${l2.totalLines.toLocaleString()} lines)`,
        );

        // L3 children
        for (const l3Id of l2.children) {
          const l3 = nodeById.get(l3Id);
          if (!l3) continue;

          lines.push(
            `    L3: ${l3.name} (${l3.files.length} files, ${l3.totalLines.toLocaleString()} lines)`,
          );
        }
      }
    }

    return lines.join('\n');
  }
}

export const codebaseMapper = new CodebaseMapper();
