export declare const PUBLIC_ENTRIES: readonly string[];

export interface BuildStaticOptions {
  readonly root?: string;
  readonly out?: string;
  readonly log?: (message: string) => void;
}

/** Copie la liste blanche publique dans `out` ; retourne les chemins relatifs copiés. */
export declare function buildStatic(options?: BuildStaticOptions): string[];
