import { ManaModule } from '@difizen/libro-common/app';

import { CodeEditorViewerOpenHandler } from './code-editor-open-handler.js';
import { CodeEditorViewer } from './code-editor-viewer.js';
import { JSONLanguageSpecs } from './json-langauge.js';
import { JuliaLanguageSpecs } from './julia-language.js';
import { LibroDefaultViewerOpenHandler } from './libro-default-open-handler.js';
import { LibroDefaultViewer } from './libro-default-viewer.js';
import { RLanguageSpecs } from './r-language.js';

export const CodeEditorViewerModule = ManaModule.create(
  'CodeEditorViewerModule',
).register(
  CodeEditorViewer,
  LibroDefaultViewer,
  CodeEditorViewerOpenHandler,
  LibroDefaultViewerOpenHandler,
  JSONLanguageSpecs,
  RLanguageSpecs,
  JuliaLanguageSpecs,
);
