import type { Command } from '../../../core/index.js';
import { CommandContribution, CommandRegistry } from '../../../core/index.js';
import { l10n } from '../../../l10n/index.js'; /* eslint-disable max-len, @typescript-eslint/indent */
import { inject, singleton } from '../../../ioc/index.js';

export const CLOSE_TAB: Command = {
  id: 'tab.close',
  label: l10n.t('关闭'),
};

@singleton({ contrib: [CommandContribution] })
export class CommonCommand implements CommandContribution {
  protected readonly commandRegistry: CommandRegistry;
  constructor(@inject(CommandRegistry) commandRegistry: CommandRegistry) {
    this.commandRegistry = commandRegistry;
  }
  registerCommands(command: CommandRegistry): void {
    command.registerCommand(CLOSE_TAB, {
      execute: () => {
        //
      },
    });
  }
}
