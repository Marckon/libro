import { ManaModule } from '../../libro-common/es/app/index.js';

import { AppFileCommandContribution } from './app-file-command-contribution.js';
import { LibroAppOpenHandler } from './app-open-handler.js';
import { LibroAppView } from './app-view.js';
import { LibroAppViewer } from './app-viewer.js';

export const LibroAppModule = ManaModule.create().register(
  AppFileCommandContribution,
  LibroAppOpenHandler,
  LibroAppViewer,
  LibroAppView,
);
