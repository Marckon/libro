import { DefaultSlotView, view, Slot } from '../../../core/index.js';
import { BoxPanel } from '../../../react/index.js';
import { singleton } from '../../../ioc/index.js';
import * as React from 'react';
import './index.less';

export enum HeaderArea {
  left = 'mana-header-left',
  right = 'mana-header-right',
  middle = 'mana-header-middle',
}

const HeaderComponent: React.ForwardRefExoticComponent<any> = React.forwardRef(
  function HeaderComponent(_props, ref: React.ForwardedRef<HTMLDivElement>) {
    return (
      <BoxPanel direction="left-to-right" className={'mana-header'} ref={ref}>
        <BoxPanel.Pane flex={1} className={'mana-header-left'}>
          <Slot name={HeaderArea.left} />
        </BoxPanel.Pane>
        <BoxPanel.Pane flex={1} className={'mana-header-middle'}>
          <Slot name={HeaderArea.middle} />
        </BoxPanel.Pane>
        <BoxPanel.Pane flex={1} className={'mana-header-right'}>
          <Slot name={HeaderArea.right} />
        </BoxPanel.Pane>
      </BoxPanel>
    );
  },
);

@singleton()
@view('header-view')
export class HeaderView extends DefaultSlotView {
  override view = HeaderComponent;
}
