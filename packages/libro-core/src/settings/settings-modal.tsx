import type { ModalItem, ModalItemProps } from '@difizen/libro-common/app';
import { ConfigurationRegistry } from '@difizen/libro-common/app';
import { useInject, ViewManager, ViewRender } from '@difizen/libro-common/app';
import { l10n } from '@difizen/libro-common/l10n';
import { Modal } from 'antd';
import { useEffect, useState } from 'react';

import { ConfigurationPanelView } from './setting-editor/index.js';
import { LibroUserSettingsNamespace } from './settings-protocol.js';
import './settings-modal.less';

export function SettingsModalComponent({ visible, close }: ModalItemProps<void>) {
  const viewManager = useInject(ViewManager);
  const configRegistry = useInject(ConfigurationRegistry);
  const [settingEditorView, setSettingEditorView] = useState<ConfigurationPanelView>();

  useEffect(() => {
    viewManager
      .getOrCreateView<ConfigurationPanelView>(ConfigurationPanelView)
      .then((view) => {
        const config = configRegistry.getConfigurationByNamespace(
          [LibroUserSettingsNamespace],
          false,
        );
        view.configurationNodes = config;
        view.className = 'libro-settings-modal';
        setSettingEditorView(view);
        return;
      })
      .catch((e) => {
        //
      });
  }, [configRegistry, viewManager]);

  return (
    <Modal
      title={l10n.t('设置')}
      open={visible}
      onOk={() => close()}
      onCancel={() => close()}
      width={600}
    >
      {settingEditorView && <ViewRender view={settingEditorView} />}
    </Modal>
  );
}

export const SettingsModal: ModalItem = {
  id: 'settings.modal',
  component: SettingsModalComponent,
};
