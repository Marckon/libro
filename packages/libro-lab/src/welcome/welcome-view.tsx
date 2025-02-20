import { ServerConnection } from '@difizen/libro-jupyter';
import {
  inject,
  singleton,
  useInject,
  view,
  ViewInstance,
  ViewManager,
  ViewRender,
} from '@difizen/libro-common/app';
import { BaseView } from '@difizen/libro-common/app';
import { l10n } from '@difizen/libro-common/l10n';
import { forwardRef } from 'react';

import { LayoutService } from '../layout/layout-service.js';

import { EntryPointView } from './entry-point-view.js';

import './index.less';

export const WelcomeComponent = forwardRef(function WelcomeComponent() {
  const instance = useInject<WelcomeView>(ViewInstance);
  const layoutService = useInject(LayoutService);
  const serverConnection = useInject(ServerConnection);
  return (
    <div className="libro-lab-welcome-page">
      <div className="libro-lab-welcome-page-title">
        {l10n.t('欢迎使用 Libro Lab🎉🎉')}
      </div>
      <div className="libro-lab-welcome-page-server-info">
        <div className="libro-lab-welcome-page-server-info-title">
          {l10n.t('服务连接信息')}
        </div>
        <div className="libro-lab-welcome-page-server-info-item">
          BaseURL: {`${serverConnection.settings.baseUrl}`}
        </div>
        <div className="libro-lab-welcome-page-server-info-item">
          WsURL: {`${serverConnection.settings.wsUrl}`}
        </div>
      </div>
      {layoutService.serverSatus === 'success' && (
        <ViewRender view={instance.entryPointView}></ViewRender>
      )}
    </div>
  );
});

@singleton()
@view('welcome-view')
export class WelcomeView extends BaseView {
  override view = WelcomeComponent;
  viewManager: ViewManager;
  entryPointView: EntryPointView;
  constructor(@inject(ViewManager) viewManager: ViewManager) {
    super();
    this.title.icon = '🙌 ';
    this.title.label = () => <div>{l10n.t('欢迎使用')}</div>;
    this.title.closable = false;
    this.viewManager = viewManager;
    this.viewManager
      .getOrCreateView(EntryPointView)
      .then((entryPointView) => {
        this.entryPointView = entryPointView;
        return;
      })
      .catch(console.error);
  }
}
