import { checkbox } from '@inquirer/prompts';
import { CONNECTORS } from '../utils/config.js';
import type { ConnectorDef } from '../types.js';
import * as log from '../utils/log.js';

export async function selectConnectors(): Promise<ConnectorDef[]> {
  log.heading('  Connector Selection');

  const selected = await checkbox({
    message: 'Which connectors do you want to deploy? (space to toggle, enter to confirm)',
    choices: CONNECTORS.map(c => ({
      name: `${c.name.padEnd(14)} — ${c.description}`,
      value: c.slug,
      checked: false,
    })),
    required: true,
    validate: (items: readonly any[]) => {
      if (items.length === 0) return 'Select at least one connector';
      return true;
    },
  });

  const connectors = CONNECTORS.filter(c => selected.includes(c.slug));
  const totalTools = connectors.reduce((sum, c) => sum + c.toolCount, 0);

  log.success(`Selected: ${connectors.length} connector${connectors.length > 1 ? 's' : ''} (${totalTools} tools)`);
  for (const c of connectors) {
    log.dim(`  ${c.name} — ${c.toolCount} tools`);
  }

  return connectors;
}
