import { API_GROUP_THRESHOLD, OPTIONAL_ENUMS, OPTIONAL_REFS, REQUIRED_FIELDS, connectionKind, type FieldRule } from './rules';
import type { Entry, Issue, Registry } from './types';

const STATUSES = ['planned', 'active', 'deprecated'];

/** Every publish-blocking rule that can be checked from the files alone. */
export function validate(reg: Registry): Issue[] {
  const issues: Issue[] = [...reg.loadIssues];
  const push = (e: Entry, message: string) => issues.push({ file: e.file, id: e.id, message });

  const checkRef = (e: Entry, rule: FieldRule, value: unknown) => {
    if (typeof value !== 'string') return push(e, `\`${rule.key}\` must be an id`);
    const target = reg.entries.get(value);
    if (!target) return push(e, `\`${rule.key}\` references unknown id "${value}"`);
    if (rule.ref && !rule.ref.includes(target.type)) {
      push(e, `\`${rule.key}\` must reference a ${rule.ref.join(' or ')}, but "${value}" is a ${target.type}`);
    }
  };

  for (const e of reg.entries.values()) {
    if (!e.name) push(e, 'Missing required field `name`');
    if (!STATUSES.includes(e.status)) push(e, `Unknown status "${e.status}"`);

    for (const rule of REQUIRED_FIELDS[e.type]) {
      const v = e.fields[rule.key];
      if (v === undefined || v === null || v === '') {
        push(e, `Missing required field \`${rule.key}\``);
        continue;
      }
      if (rule.ref) checkRef(e, rule, v);
      if (rule.oneOf && !rule.oneOf.includes(String(v))) {
        push(e, `\`${rule.key}\` must be one of ${rule.oneOf.join(', ')}`);
      }
    }
    for (const rule of OPTIONAL_REFS[e.type] ?? []) {
      const v = e.fields[rule.key];
      if (v !== undefined && v !== null) checkRef(e, rule, v);
    }

    for (const rule of OPTIONAL_ENUMS[e.type] ?? []) {
      const v = e.fields[rule.key];
      if (v !== undefined && v !== null && !rule.oneOf.includes(String(v))) {
        push(e, `\`${rule.key}\` must be one of ${rule.oneOf.join(', ')}`);
      }
    }
    if (e.fields.tags !== undefined && !(Array.isArray(e.fields.tags) && e.fields.tags.every((t) => typeof t === 'string'))) {
      push(e, '`tags` must be a list of strings');
    }
    if (e.fields.ownership === 'disputed' && !e.fields.claimant) push(e, 'A disputed service needs a `claimant` domain');
    if (e.type === 'api' && e.fields.supersedes === e.id) push(e, 'An API cannot supersede itself');

    // Parents declared in a domain file must belong to that domain.
    if (e.type === 'service' && typeof e.fields.system === 'string') {
      const sys = reg.entries.get(e.fields.system);
      if (sys && sys.domain !== e.domain) push(e, `System "${sys.id}" belongs to another domain`);
    }
    for (const key of ['hostedBy', 'ownedBy'] as const) {
      const v = e.fields[key];
      if (typeof v !== 'string' || e.type === 'external') continue;
      const owner = reg.entries.get(v);
      if (owner && owner.domain !== e.domain) push(e, `\`${key}\` "${v}" is declared in another domain file`);
    }
  }

  // Hosts with many APIs group them by tag, so each of their APIs needs one.
  const apisByHost = new Map<string, Entry[]>();
  for (const e of reg.entries.values()) {
    if (e.type !== 'api' || typeof e.fields.hostedBy !== 'string') continue;
    if (!apisByHost.has(e.fields.hostedBy)) apisByHost.set(e.fields.hostedBy, []);
    apisByHost.get(e.fields.hostedBy)!.push(e);
  }
  for (const [host, apis] of apisByHost) {
    if (apis.length <= API_GROUP_THRESHOLD) continue;
    for (const a of apis) {
      if (!Array.isArray(a.fields.tags) || !a.fields.tags.length) {
        push(a, `Host "${host}" has ${apis.length} APIs (more than ${API_GROUP_THRESHOLD}), so each needs \`tags\``);
      }
    }
  }

  for (const c of reg.connections) {
    const label = `${c.from} → ${c.to}`;
    const from = reg.entries.get(c.from);
    const to = reg.entries.get(c.to);
    if (!from || !to) {
      issues.push({ file: c.file, id: label, message: `Connection references unknown id "${!from ? c.from : c.to}"` });
      continue;
    }
    const kind = connectionKind(from.type, to.type);
    if (!kind) {
      issues.push({ file: c.file, id: label, message: `A ${from.type} cannot connect to a ${to.type}` });
      continue;
    }
    if (kind === 'calls-unknown' && !c.gap) {
      issues.push({
        file: c.file,
        id: label,
        message: 'Service-to-service call with no API needs a `gap` reason, e.g. gap: "legacy, no spec"',
      });
    }
    if (kind === 'reads-writes' && to.fields.ownedBy === from.id) {
      issues.push({ file: c.file, id: label, message: 'An owner’s access to its datastore is implicit; remove this connection' });
    }
  }

  for (const t of reg.tours) {
    t.steps.forEach((step, i) => {
      const where = { file: t.file, id: `${t.id} step ${i + 1}` };
      const known = (id: unknown) => typeof id === 'string' && reg.entries.has(id);
      if (!step || typeof step.caption !== 'string') issues.push({ ...where, message: 'A tour step needs a `caption`' });
      if (!step.focus && !step.trace && !step.impact) issues.push({ ...where, message: 'A tour step needs `focus`, `trace` or `impact`' });
      if (step.focus !== undefined && !known(step.focus)) issues.push({ ...where, message: `Unknown focus id "${step.focus}"` });
      if (step.impact !== undefined && !known(step.impact)) issues.push({ ...where, message: `Unknown impact id "${step.impact}"` });
      if (step.trace !== undefined && !(Array.isArray(step.trace) && step.trace.length === 2 && step.trace.every(known))) {
        issues.push({ ...where, message: '`trace` must be two known ids: [from, to]' });
      }
    });
  }

  return issues.sort((a, b) => a.file.localeCompare(b.file) || (a.id ?? '').localeCompare(b.id ?? ''));
}
