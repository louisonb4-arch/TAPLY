import type { AppConfig } from '../core/config.js';
import type { Logger } from '../core/logger.js';

/** Variables disponibles dans le contexte Hono de chaque requête. */
export interface AppVariables {
  config: AppConfig;
  rootLog: Logger;
  log: Logger;
  requestId: string;
}

export interface AppEnvBindings {
  Variables: AppVariables;
}
