import { ApplicationContribution } from '../../core/index.js';
import { inject } from '../../ioc/index.js';
import { singleton } from '../../ioc/index.js';

import { ModalService } from './modal-service.js';

@singleton({ contrib: [ApplicationContribution] })
export class ModalApplicationContribution implements ApplicationContribution {
  @inject(ModalService) modalService: ModalService;
  onStart() {
    this.modalService.init();
  }
}
