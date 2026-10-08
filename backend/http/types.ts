import type { AppConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';
import type { Pool } from 'pg';

/** Variables disponibles dans le contexte Hono de chaque requête. */
export interface AppVariables {
  config: AppConfig;
  rootLog: Logger;
  log: Logger;
  requestId: string;
  dbPool?: Pool;
}

export interface AppEnvBindings {
  Variables: AppVariables;
}
