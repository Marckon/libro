import type { ICodeCell } from '@difizen/libro-common';
import { watch } from '@difizen/libro-common/app';
import { ViewOption } from '@difizen/libro-common/app';
import { inject } from '@difizen/libro-common/app';

import type { CellModel } from '../libro-protocol.js';
import type { CellViewOptions } from '../libro-protocol.js';
import type { BaseOutputArea } from '../output/index.js';

import type { LibroCell } from './libro-cell-protocol.js';
import { CellService } from './libro-cell-protocol.js';
import { EditorCellView, LibroEditorCellView } from './libro-edit-cell-view.js';
import { ExecutableCellModel } from './libro-executable-cell-model.js';

interface ExecutableCellView extends EditorCellView {
  run: () => Promise<boolean>;
  clearExecution: () => void;

  outputArea: BaseOutputArea;

  noEditorAreaHeight: number;
}

export const ExecutableCellView = {
  is: (arg: Record<any, any> | undefined): arg is ExecutableCellView => {
    return (
      !!arg &&
      EditorCellView.is(arg as any) &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      'outputArea' in arg &&
      typeof (arg as any).outputArea === 'object' &&
      'clearExecution' in arg &&
      typeof (arg as any).clearExecution === 'function' &&
      typeof (arg as any).run === 'function'
    );
  },
};

/**
 * 带有编辑器、执行、output相关能力的cell view，例如python、sql
 * model 必须为 ExecutableCellModel
 */
export abstract class LibroEditableExecutableCellView
  extends LibroEditorCellView
  implements ExecutableCellView
{
  declare model: CellModel & ExecutableCellModel;

  outputArea: BaseOutputArea;

  declare noEditorAreaHeight: number;

  constructor(
    @inject(ViewOption) options: CellViewOptions,
    @inject(CellService) cellService: CellService,
  ) {
    super(options, cellService);
    this.outputWatch();
  }

  clearExecution: () => void = () => {
    //
  };

  // TODO: 性能！
  override hasCellHidden() {
    if (
      !ExecutableCellModel.is(this.model) ||
      (this.outputArea && this.outputArea.length < 1)
    ) {
      return this.hasInputHidden;
    }
    return this.hasInputHidden && this.model.hasOutputHidden;
  }

  outputWatch() {
    this.toDispose.push(
      watch(this.outputArea, 'outputs', () => {
        this.parent.model.onChange?.();
      }),
    );
  }

  override toJSON(): LibroCell {
    const meta = super.toJSON();
    return {
      ...meta,
      source: meta.source ?? this.options.cell.source,
      outputs: this.outputArea?.toJSON() ?? [],
    } as ICodeCell;
  }
}

/**
 * @deprecated use LibroEditableExecutableCellView instead.
 */
export const LibroExecutableCellView = LibroEditableExecutableCellView;
