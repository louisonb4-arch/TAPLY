/**
 * Garde-fou : aucune requête nommée (`{ name: ... }`) dans backend/db/**.
 * Une requête nommée serait mise en cache côté pg côté session — risque
 * d'incompatibilité avec le mode transaction du Transaction Pooler, qui ne
 * garantit pas la même connexion physique entre deux appels.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DB_DIR = fileURLToPath(new URL('../../../backend/db', import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? tsFiles(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [],
  );
}

describe('backend/db : aucune requête pg nommée', () => {
  for (const file of tsFiles(DB_DIR)) {
    it(`${file.replace(DB_DIR, 'backend/db')} ne passe pas de champ "name" à .query(`, () => {
      const content = readFileSync(file, 'utf8');
      expect(content).not.toMatch(/\.query\(\s*\{[^)]*\bname\s*:/s);
    });
  }
});
