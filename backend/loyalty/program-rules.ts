/**
 * Contrat de fidélité versionné : seuil + récompenses proposées.
 *
 * Stocké dans program_rule_versions.rules (jsonb). Une carte épingle la
 * version de son cycle (memberships.current_rule_version_id) : seuil ET
 * récompenses restent ceux du cycle en cours jusqu'à la remise.
 *
 * Compatibilité : les versions antérieures ne contiennent que
 * `{ threshold }`. La récompense provient alors du titre publié
 * (program_publications.reward_title), exposée sous la clé `default`.
 */
import { z } from 'zod';
import { MAX_THRESHOLD, MIN_THRESHOLD } from './types.js';

export const MAX_REWARDS = 5;
export const LEGACY_REWARD_KEY = 'default';

export interface RewardOption {
  readonly key: string;
  readonly title: string;
}

export interface ProgramContract {
  readonly threshold: number;
  readonly rewards: readonly RewardOption[];
}

const rewardTitle = z.string().trim().min(2).max(120)
  .refine((v) => !/[\x00-\x1F\x7F]/.test(v), 'caractères de contrôle interdits');

const rewardSchema = z.strictObject({
  key: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  title: rewardTitle,
});

const storedRulesSchema = z.object({
  threshold: z.number().int().min(MIN_THRESHOLD).max(MAX_THRESHOLD),
  rewards: z.array(rewardSchema).min(1).max(MAX_REWARDS).optional(),
});

/** Saisie commerçant : titres seulement, clés attribuées côté serveur. */
export const contractInputSchema = z.strictObject({
  threshold: z.number().int().min(MIN_THRESHOLD).max(MAX_THRESHOLD),
  rewards: z.array(rewardTitle).min(1).max(MAX_REWARDS),
});
export type ContractInput = z.infer<typeof contractInputSchema>;

/**
 * Lit une version stockée. `legacyRewardTitle` sert uniquement aux versions
 * antérieures sans `rewards`. Retourne null si la version est inexploitable.
 */
export function parseStoredContract(raw: unknown, legacyRewardTitle: string | null | undefined): ProgramContract | null {
  const parsed = storedRulesSchema.safeParse(raw);
  if (!parsed.success) return null;
  const rewards = parsed.data.rewards ?? (
    legacyRewardTitle && legacyRewardTitle.trim().length >= 2
      ? [{ key: LEGACY_REWARD_KEY, title: legacyRewardTitle.trim() }]
      : []
  );
  const keys = new Set(rewards.map((r) => r.key));
  if (keys.size !== rewards.length) return null;
  return { threshold: parsed.data.threshold, rewards };
}

/**
 * Construit le JSON stocké à partir d'une saisie validée. Les clés restent
 * stables pour un même titre (r1, r2… dans l'ordre), les doublons de titre
 * sont refusés.
 */
export function buildStoredRules(input: ContractInput): { threshold: number; rewards: RewardOption[] } | null {
  const titles = input.rewards.map((t) => t.trim());
  const normalized = new Set(titles.map((t) => t.toLocaleLowerCase('fr-FR')));
  if (normalized.size !== titles.length) return null;
  return {
    threshold: input.threshold,
    rewards: titles.map((title, index) => ({ key: 'r' + (index + 1), title })),
  };
}

/** Deux contrats sont-ils identiques (aucune nouvelle version nécessaire) ? */
export function sameContract(a: ProgramContract, b: { threshold: number; rewards: readonly RewardOption[] }): boolean {
  return a.threshold === b.threshold
    && a.rewards.length === b.rewards.length
    && a.rewards.every((r, i) => r.title === b.rewards[i]?.title && r.key === b.rewards[i]?.key);
}
