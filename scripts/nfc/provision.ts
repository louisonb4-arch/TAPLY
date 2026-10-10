/**
 * CLI de personnalisation NTAG 424 DNA — MODE SIMULATION À SEC.
 *
 *   node --import ./scripts/dev-ts-hooks.mjs scripts/nfc/provision.ts \
 *     --uid 04XXXXXXXXXXXX --host taply.fr \
 *     --master-file ~/.config/taply/nfc-master-v1.hex [--key-version 1] [--show-keys]
 *
 * Aucune puce n'est contactée : le transport PC/SC n'est pas implémenté
 * (matériel non reçu). La sortie décrit le plan, le contenu NDEF, les offsets
 * SDM, les réglages de fichier et la vérification au téléphone.
 *
 * --show-keys affiche les 5 clés (hex) pour une saisie manuelle dans NXP
 * TagXplorer, UNIQUEMENT sur un terminal interactif (refusé si la sortie est
 * redirigée : les clés ne doivent jamais finir dans un fichier). Le secret
 * maître doit être celui du serveur (TAPLY_NFC_MASTER_KEY) et la version
 * celle de TAPLY_NFC_KEY_VERSION.
 */

import { NDEF_FILE_NO } from './ev2.js';
import {
  ProvisioningError,
  buildProvisioningPlan,
  deriveProvisioningKeys,
  loadMasterKeyFile,
  type ProvisioningPlan,
} from './plan.js';

// ── Args ────────────────────────────────────────────────────────────

interface CliArgs {
  readonly uid: string;
  readonly host: string;
  readonly masterFile: string;
  readonly keyVersion: number;
  readonly showKeys: boolean;
}

const USAGE = `Usage : node --import ./scripts/dev-ts-hooks.mjs scripts/nfc/provision.ts \\
  --uid 04XXXXXXXXXXXX --host taply.fr --master-file <fichier 600> [--key-version 1] [--show-keys]`;

class UsageError extends Error {}

function expandHome(path: string): string {
  const home = process.env['HOME'];
  if (path === '~') return home ?? path;
  if (path.startsWith('~/') && home !== undefined) return `${home}${path.slice(1)}`;
  return path;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const values = new Map<string, string>();
  let showKeys = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--show-keys') {
      showKeys = true;
      continue;
    }
    const [name, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (!['--uid', '--host', '--master-file', '--key-version'].includes(name)) throw new UsageError(`option inconnue : ${arg}`);
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`valeur manquante pour ${name}`);
    if (values.has(name)) throw new UsageError(`option répétée : ${name}`);
    values.set(name, value);
  }
  const uid = values.get('--uid');
  const host = values.get('--host');
  const masterFile = values.get('--master-file');
  if (masterFile === undefined) throw new UsageError('--master-file est obligatoire (aucun secret par défaut)');
  if (uid === undefined) throw new UsageError('--uid est obligatoire');
  if (host === undefined) throw new UsageError('--host est obligatoire');
  const versionRaw = values.get('--key-version') ?? '1';
  if (!/^\d{1,3}$/.test(versionRaw)) throw new UsageError('--key-version doit être un entier 1..255');
  return { uid, host, masterFile: expandHome(masterFile), keyVersion: Number(versionRaw), showKeys };
}

// ── Output ──────────────────────────────────────────────────────────

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

function hex(buf: Buffer): string {
  return buf.toString('hex').toUpperCase();
}

function hexDump(buf: Buffer): string[] {
  const lines: string[] = [];
  for (let off = 0; off < buf.length; off += 16) {
    const chunk = buf.subarray(off, off + 16);
    const bytes = hex(chunk).replace(/(..)(?=.)/g, '$1 ').padEnd(47, ' ');
    const ascii = [...chunk].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`  ${off.toString(16).toUpperCase().padStart(3, '0')}  ${bytes}  ${ascii}`);
  }
  return lines;
}

function offsetLine(name: string, value: number): string {
  const le = Buffer.alloc(3);
  le.writeUIntLE(value, 0, 3);
  return `  ${name.padEnd(20)} = ${value} (0x${value.toString(16).toUpperCase().padStart(2, '0')}, LSB d'abord : ${hex(le)})`;
}

function printPlan(plan: ProvisioningPlan): void {
  const { ndef } = plan;
  out('== Taply — personnalisation NTAG 424 DNA — SIMULATION À SEC (aucune puce contactée) ==');
  out(`UID              : ${plan.uidHex}`);
  out(`Hôte (gravé)     : ${plan.host}   ← définitif : reprogrammer exige la clé 0`);
  out(`URL gabarit      : ${ndef.templateUrl}`);
  out(`Version de clés  : ${plan.keyVersion} (KeyVer ${plan.keyVersion.toString(16).toUpperCase().padStart(2, '0')}h sur les 5 clés ; doit égaler TAPLY_NFC_KEY_VERSION)`);
  out();
  out('== Plan de clés (valeurs non affichées) ==');
  for (const slot of plan.keySlots) out(`  Clé ${slot.slot} = ${slot.role.padEnd(15)} [${slot.diversification}] — ${slot.usage}`);
  out();
  out(`== Contenu NDEF du fichier ${NDEF_FILE_NO.toString(16).padStart(2, '0')} (E104h), ${ndef.bytes.length} octets, écrit à l'offset 0 ==`);
  out(`  ${hex(ndef.bytes)}`);
  for (const line of hexDump(ndef.bytes)) out(line);
  out();
  out('== Offsets SDM (depuis le début du fichier, NLEN inclus) ==');
  out(offsetLine('PICCDataOffset (e)', ndef.piccDataOffset));
  out(offsetLine('SDMMACInputOffset', ndef.sdmMacInputOffset));
  out(offsetLine('SDMMACOffset (c)', ndef.sdmMacOffset));
  out('  SDMMACInputOffset = SDMMACOffset ⇒ SDMMAC calculée sur une entrée VIDE (attendu par le serveur).');
  out();
  out('== ChangeFileSettings fichier 02 (données, sans FileNo) ==');
  out(`  ${hex(plan.fileSettings)}`);
  const fs = plan.fileSettings;
  out(`  ${hex(fs.subarray(0, 1))}        FileOption : SDM + miroir activés, CommMode.Plain`);
  out(`  ${hex(fs.subarray(1, 3))}      AccessRights : ReadWrite=0, Change=0 | Read=E (libre), Write=0`);
  out(`  ${hex(fs.subarray(3, 4))}        SDMOptions : UID + SDMReadCtr mirroring, encodage ASCII`);
  out(`  ${hex(fs.subarray(4, 6))}      SDMAccessRights : RFU=F, SDMCtrRet=F (GetFileCounters interdit) | SDMMetaRead=1, SDMFileRead=2`);
  out(`  ${hex(fs.subarray(6, 9))}    PICCDataOffset`);
  out(`  ${hex(fs.subarray(9, 12))}    SDMMACInputOffset`);
  out(`  ${hex(fs.subarray(12, 15))}    SDMMACOffset`);
  out(`  GetFileSettings(02) usine attendu      : ${hex(plan.factoryFileSettings)}`);
  out(`  GetFileSettings(02) après personnal.   : ${hex(plan.expectedFileSettings)}`);
  out();
  out('== Étapes (ordre d\'exécution ; aucune n\'est exécutée ici) ==');
  plan.steps.forEach((step, i) => {
    out(`${String(i + 1).padStart(2)}. ${step.title}`);
    out(`    APDU    : ${step.apduDescription}`);
    out(`    Auth    : ${step.needsAuthWithKey === null ? 'aucune requise' : `clé ${step.needsAuthWithKey} (session active)`}`);
    out(`    Secrets : ${step.secretsUsed.length === 0 ? 'aucun' : step.secretsUsed.join(', ')}`);
  });
  out();
  out('== Transport lecteur ==');
  out('  PC/SC : EN ATTENTE DU MATÉRIEL — non implémenté. runProvisioning(transport, plan, clés) est prêt');
  out('  derrière l\'interface Transport { transmit(apdu): Promise<Buffer> } (testé sur puce simulée uniquement).');
  out('  Aucune compatibilité matérielle n\'a été vérifiée.');
  out();
  out('== Vérification au téléphone (après personnalisation) ==');
  out('  1. Approcher un téléphone NFC (déverrouillé) : il doit proposer d\'ouvrir');
  out(`     https://${plan.host}/t?e=<32 hex>&c=<16 hex>  — e et c changent à CHAQUE tap.`);
  out('  2. Deux taps successifs ⇒ deux URL différentes. Une URL toujours identique ou avec des zéros');
  out('     = SDM non actif : NE PAS déployer la puce.');
  out('  3. Dashboard « QR & NFC » → « Associer une puce » puis tap avec le téléphone du propriétaire');
  out('     connecté : la première lecture SUN valide enregistre la puce (backend/nfc/tap.ts).');
  out('  4. Ne jamais publier/partager une URL de tap : non consommée, elle reste valable.');
}

function printKeys(plan: ProvisioningPlan, masterHex: string): void {
  const keys = deriveProvisioningKeys(masterHex, plan.uidHex, plan.keyVersion);
  out();
  out('!!! ATTENTION — CLÉS SECRÈTES CI-DESSOUS !!!');
  out('!!! Ne pas copier dans un fichier, un ticket, un chat ni une capture. Effacer le terminal après usage.');
  out('!!! La clé 1 (sdmMetaReadKey) est COMMUNE à tous les tags de cette version : sa fuite affaiblit tout le parc.');
  for (const slot of plan.keySlots) {
    const key = keys.slot(slot.slot);
    out(`  Clé ${slot.slot} (${slot.role.padEnd(14)}) version ${plan.keyVersion.toString(16).toUpperCase().padStart(2, '0')}h : ${hex(key)}`);
    key.fill(0);
  }
}

// ── Main ────────────────────────────────────────────────────────────

function main(): number {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }
  if (args.showKeys && process.stdout.isTTY !== true) {
    process.stderr.write('--show-keys refusé : la sortie standard n\'est pas un terminal (les clés ne doivent jamais être écrites dans un fichier ou un pipe).\n');
    return 2;
  }
  try {
    const masterHex = loadMasterKeyFile(args.masterFile);
    const plan = buildProvisioningPlan({ masterKeyHex: masterHex, uidHex: args.uid, keyVersion: args.keyVersion, host: args.host });
    printPlan(plan);
    if (args.showKeys) printKeys(plan, masterHex);
    return 0;
  } catch (error) {
    const message = error instanceof ProvisioningError || error instanceof Error ? error.message : String(error);
    process.stderr.write(`Refusé : ${message}\n`);
    return 1;
  }
}

process.exitCode = main();
