import type { ConfigurationNode } from '@difizen/libro-common/app';
import { ConfigurationContribution } from '@difizen/libro-common/app';
import { singleton } from '@difizen/libro-common/app';
import { l10n } from '@difizen/libro-common/l10n';

export const TOCVisible: ConfigurationNode<boolean> = {
  id: 'libro.toc.visible',
  description: l10n.t('是否显示侧边的TOC'),
  title: 'TOC',
  type: 'checkbox',
  defaultValue: true,
  schema: {
    type: 'boolean',
  },
};

@singleton({ contrib: ConfigurationContribution })
export class TOCSettingContribution implements ConfigurationContribution {
  registerConfigurations() {
    return [TOCVisible];
  }
}
