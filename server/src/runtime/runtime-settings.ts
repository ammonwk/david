import type { AgentBackend, RuntimeSettings } from 'david-shared';
import { config } from '../config.js';
import { RuntimeSettingsModel } from '../db/models.js';

let currentCLIBackend: AgentBackend = config.cliBackend;
let initialized = false;
let initializationPromise: Promise<void> | null = null;

function normalizeSettings(settings: RuntimeSettings): RuntimeSettings {
  return {
    cliBackend: settings.cliBackend,
    updatedAt: new Date(settings.updatedAt),
  };
}

export async function initializeRuntimeSettings(): Promise<void> {
  if (initialized) return;
  if (!initializationPromise) {
    initializationPromise = (async () => {
      const existing = await RuntimeSettingsModel.findById('singleton').lean<RuntimeSettings | null>();

      if (existing) {
        currentCLIBackend = existing.cliBackend;
      } else {
        await RuntimeSettingsModel.create({
          _id: 'singleton',
          cliBackend: currentCLIBackend,
          updatedAt: new Date(),
        });
      }

      initialized = true;
    })();
  }

  await initializationPromise;
}

export function getCLIBackend(): AgentBackend {
  return currentCLIBackend;
}

export async function getRuntimeSettings(): Promise<RuntimeSettings> {
  await initializeRuntimeSettings();

  const settings = await RuntimeSettingsModel.findById('singleton').lean<RuntimeSettings | null>();
  if (!settings) {
    return {
      cliBackend: currentCLIBackend,
      updatedAt: new Date(),
    };
  }

  return normalizeSettings(settings);
}

export async function updateRuntimeSettings(
  cliBackend: AgentBackend,
): Promise<RuntimeSettings> {
  await initializeRuntimeSettings();

  currentCLIBackend = cliBackend;

  const settings = await RuntimeSettingsModel.findOneAndUpdate(
    { _id: 'singleton' },
    {
      _id: 'singleton',
      cliBackend,
      updatedAt: new Date(),
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  ).lean<RuntimeSettings | null>();

  if (!settings) {
    return {
      cliBackend,
      updatedAt: new Date(),
    };
  }

  return normalizeSettings(settings);
}
