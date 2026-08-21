import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import matter from 'gray-matter';

export interface PlaybookScenario {
  feature: string;
  name: string;
  tags: string[];
}

export interface PlaybookCiStatus {
  status: 'passing' | 'failing' | 'unknown';
  passed?: number;
  failed?: number;
  total?: number;
  coverage?: number | null;
  runUrl?: string | null;
  ranAt?: string | null;
}

export interface PlaybookSummary {
  module: string;
  title: string;
  status: string;
  phase?: number;
  migratedAt?: string | null;
  scenarioCount: number;
  ci: PlaybookCiStatus;
}

export interface PlaybookDetail extends PlaybookSummary {
  frontmatter: Record<string, unknown>;
  markdown: string;
  scenarios: PlaybookScenario[];
}

/**
 * Serves the per-module playbooks the super-admin viewer renders. The markdown
 * source of truth is `src/modules/<module>/PLAYBOOK.md`; this service reads it at
 * runtime and merges live status: scenario counts parsed from the module's
 * `.feature` files, and pass/fail/coverage from a `ci-status.json` the CI
 * workflow publishes (absent → status 'unknown', counts still shown).
 */
@Injectable()
export class AdminPlaybooksService {
  private readonly logger = new Logger(AdminPlaybooksService.name);

  /** Candidate roots that hold `<module>/PLAYBOOK.md` (dev/test/CI use src). */
  private readonly moduleRoots = [
    path.join(process.cwd(), 'src', 'modules'),
    path.join(process.cwd(), 'dist', 'modules'),
  ];

  private async resolveModulesRoot(): Promise<string | null> {
    for (const root of this.moduleRoots) {
      try {
        await fs.access(root);
        return root;
      } catch {
        /* try next */
      }
    }
    return null;
  }

  private async findPlaybookFiles(): Promise<Array<{ module: string; file: string; dir: string }>> {
    const root = await this.resolveModulesRoot();
    if (!root) return [];
    const entries = await fs.readdir(root, { withFileTypes: true });
    const out: Array<{ module: string; file: string; dir: string }> = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      const file = path.join(dir, 'PLAYBOOK.md');
      try {
        await fs.access(file);
        out.push({ module: e.name, file, dir });
      } catch {
        /* module without a playbook — skip */
      }
    }
    return out;
  }

  private async parseFeatures(dir: string): Promise<PlaybookScenario[]> {
    const featuresDir = path.join(dir, 'features');
    let files: string[];
    try {
      files = (await fs.readdir(featuresDir)).filter((f) => f.endsWith('.feature'));
    } catch {
      return [];
    }
    const scenarios: PlaybookScenario[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = await fs.readFile(path.join(featuresDir, f), 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      let pendingTags: string[] = [];
      for (const raw of lines) {
        const line = raw.trim();
        if (line.startsWith('@')) {
          pendingTags = line.split(/\s+/).filter((t) => t.startsWith('@'));
          continue;
        }
        const m = line.match(/^Scenario(?: Outline)?:\s*(.+)$/);
        if (m) {
          scenarios.push({ feature: f, name: m[1].trim(), tags: pendingTags });
          pendingTags = [];
        } else if (line && !line.startsWith('#')) {
          // A non-tag, non-scenario line resets any dangling tags only when it's
          // a Feature/Background/step header — keep it simple: clear on blank.
          if (line === '') pendingTags = [];
        }
      }
    }
    return scenarios;
  }

  private async readCiStatus(module: string, dir: string): Promise<PlaybookCiStatus> {
    // Look in a few conventional spots the CI workflow may publish to.
    const candidates = [
      path.join(dir, 'ci-status.json'),
      path.join(process.cwd(), 'ci-status', `${module}.json`),
      path.join(process.cwd(), 'ci-status.json'),
    ];
    for (const c of candidates) {
      try {
        const raw = await fs.readFile(c, 'utf8');
        const json = JSON.parse(raw);
        // Allow either a flat object or a keyed-by-module map.
        const s = json[module] ?? json;
        return {
          status: s.status ?? (s.failed ? 'failing' : s.passed ? 'passing' : 'unknown'),
          passed: s.passed,
          failed: s.failed,
          total: s.total ?? ((s.passed ?? 0) + (s.failed ?? 0) || undefined),
          coverage: s.coverage ?? null,
          runUrl: s.runUrl ?? s.run_url ?? null,
          ranAt: s.ranAt ?? s.ran_at ?? null,
        };
      } catch {
        /* try next candidate */
      }
    }
    return { status: 'unknown' };
  }

  async list(): Promise<PlaybookSummary[]> {
    const files = await this.findPlaybookFiles();
    const summaries: PlaybookSummary[] = [];
    for (const { module, file, dir } of files) {
      try {
        const parsed = matter(await fs.readFile(file, 'utf8'));
        const fm = parsed.data as Record<string, any>;
        const scenarios = await this.parseFeatures(dir);
        const ci = await this.readCiStatus(module, dir);
        summaries.push({
          module: fm.module || module,
          title: fm.title || module,
          status: fm.status || 'unknown',
          phase: fm.phase,
          migratedAt: fm.migratedAt || null,
          scenarioCount: scenarios.length,
          ci,
        });
      } catch (err: any) {
        this.logger.warn(`Failed to read playbook for ${module}: ${err?.message || err}`);
      }
    }
    return summaries.sort((a, b) => (a.phase ?? 99) - (b.phase ?? 99));
  }

  async get(module: string): Promise<PlaybookDetail> {
    const files = await this.findPlaybookFiles();
    const hit = files.find((f) => f.module === module);
    if (!hit) throw new NotFoundException(`No playbook for module '${module}'`);

    const parsed = matter(await fs.readFile(hit.file, 'utf8'));
    const fm = parsed.data as Record<string, any>;
    const scenarios = await this.parseFeatures(hit.dir);
    const ci = await this.readCiStatus(module, hit.dir);

    return {
      module: fm.module || module,
      title: fm.title || module,
      status: fm.status || 'unknown',
      phase: fm.phase,
      migratedAt: fm.migratedAt || null,
      scenarioCount: scenarios.length,
      ci,
      frontmatter: fm,
      markdown: parsed.content.trim(),
      scenarios,
    };
  }
}
