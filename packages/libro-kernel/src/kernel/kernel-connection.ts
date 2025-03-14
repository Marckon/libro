import type { JSONObject } from '@difizen/libro-common';
import { deepCopy, URL } from '@difizen/libro-common';
import type { Event as ManaEvent } from '@difizen/libro-common/app';
import { Disposable } from '@difizen/libro-common/app';
import { prop } from '@difizen/libro-common/app';
import { Deferred, Emitter } from '@difizen/libro-common/app';
import { inject, transient } from '@difizen/libro-common/app';
import { v4 } from 'uuid';

import type { ISpecModel } from '../kernelspec/index.js';
import { KernelSpecRestAPI } from '../kernelspec/index.js';
import { NetworkError, ServerConnection } from '../server/index.js';
import type { ISettings } from '../server/index.js';

import { CommHandler } from './comm.js';
import type { KernelFutureHandler } from './future.js';
import { KernelControlFutureHandler, KernelShellFutureHandler } from './future.js';
import type {
  ConnectionStatus,
  IAnyMessageArgs,
  IComm,
  IControlFuture,
  IFuture,
  IKernelConnection,
  IKernelModel,
  IShellFuture,
} from './libro-kernel-protocol.js';
import {
  KernelConnectionOptions,
  LibroKernelConnectionFactory,
} from './libro-kernel-protocol.js';
import {
  isDisplayDataMsg,
  isExecuteResultMsg,
  isInfoRequestMsg,
  isUpdateDisplayDataMsg,
} from './libro-kernel-utils.js';
import * as KernelMessage from './messages.js';
import * as restapi from './restapi.js';
import { KernelRestAPI } from './restapi.js';
import { deserialize, serialize } from './serialize.js';
import * as validate from './validate.js';

// 以下 三个 没必要follow jupyter lab

// Stub for requirejs.
declare let requirejs: any;

/**
 * A protected namespace for the Kernel.
 */
namespace Private {
  /**
   * Log the current kernel status.
   */
  export function logKernelStatus(kernel: IKernelConnection): void {
    switch (kernel.status) {
      case 'idle':
      case 'busy':
      case 'unknown':
        return;
      default:
        // eslint-disable-next-line no-console
        console.debug(`Kernel: ${kernel.status} (${kernel.id})`);
        break;
    }
  }

  /**
   * Send a kernel message to the kernel and resolve the reply message.
   */
  export async function handleShellMessage<T extends KernelMessage.ShellMessageType>(
    kernel: IKernelConnection,
    msg: KernelMessage.IShellMessage<T>,
  ): Promise<KernelMessage.IShellMessage<KernelMessage.ShellMessageType>> {
    const future = kernel.sendShellMessage(msg, true);
    return future.done;
  }

  /**
   * Try to load an object from a module or a registry.
   *
   * Try to load an object from a module asynchronously if a module
   * is specified, otherwise tries to load an object from the global
   * registry, if the global registry is provided.
   *
   * #### Notes
   * Loading a module uses requirejs.
   */
  export function loadObject(
    name: string,
    moduleName: string | undefined,
    registry?: Record<string, any>,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      // Try loading the module using require.js
      if (moduleName) {
        if (typeof requirejs === 'undefined') {
          throw new Error('requirejs not found');
        }
        requirejs(
          [moduleName],
          (mod: any) => {
            if (mod[name] === void 0) {
              const msg = `Object '${name}' not found in module '${moduleName}'`;
              reject(new Error(msg));
            } else {
              resolve(mod[name]);
            }
          },
          reject,
        );
      } else {
        if (registry?.[name]) {
          resolve(registry[name]);
        } else {
          reject(new Error(`Object '${name}' not found in registry`));
        }
      }
    });
  }

  /**
   * Get a random integer between min and max, inclusive of both.
   *
   * #### Notes
   * From
   * https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Math/random#Getting_a_random_integer_between_two_values_inclusive
   *
   * From the MDN page: It might be tempting to use Math.round() to accomplish
   * that, but doing so would cause your random numbers to follow a non-uniform
   * distribution, which may not be acceptable for your needs.
   */
  export function getRandomIntInclusive(min: number, max: number): number {
    const _min = Math.ceil(min);
    const _max = Math.floor(max);
    return Math.floor(Math.random() * (_max - _min + 1)) + _min;
  }
}

const KERNEL_INFO_TIMEOUT = 3000;
const RESTARTING_KERNEL_SESSION = '_RESTARTING_';
const STARTING_KERNEL_SESSION = '';

/**
 * Implementation of the Kernel object.
 *
 * #### Notes
 * Messages from the server are handled in the order they were received and
 * asynchronously. Any message handler can return a promise, and message
 * handling will pause until the promise is fulfilled.
 */
@transient()
export class KernelConnection implements IKernelConnection {
  @inject(KernelSpecRestAPI) kernelSpecRestAPI: KernelSpecRestAPI;
  @inject(KernelRestAPI) kernelRestAPI: KernelRestAPI;
  @inject(LibroKernelConnectionFactory)
  libroKernelConnectionFactory: LibroKernelConnectionFactory;
  /**
   * Construct a kernel object.
   */
  constructor(
    @inject(KernelConnectionOptions) options: KernelConnectionOptions,
    @inject(ServerConnection) serverConnection: ServerConnection,
  ) {
    this.serverSettings = { ...serverConnection.settings, ...options.serverSettings };
    this._name = options.model.name;
    this._id = options.model.id;

    this._clientId = options.clientId ?? v4();
    this._username = options.username ?? '';
    this.handleComms = options.handleComms ?? true;

    this._createSocket();
  }

  send(msg: string | ArrayBuffer) {
    this._ws?.send(msg);
  }

  get onDisposed(): ManaEvent<void> {
    return this.onDisposedEmitter.event;
  }

  /**
   * The server settings for the kernel.
   */
  readonly serverSettings: ISettings;

  /**
   * Handle comm messages
   *
   * #### Notes
   * The comm message protocol currently has implicit assumptions that only
   * one kernel connection is handling comm messages. This option allows a
   * kernel connection to opt out of handling comms.
   *
   * See https://github.com/jupyter/jupyter_client/issues/263
   */
  readonly handleComms: boolean;

  /**
   * A signal emitted when the kernel status changes.
   */
  get statusChanged(): ManaEvent<KernelMessage.Status> {
    return this.statusChangedEmitter.event;
  }

  /**
   * A signal emitted when the kernel status changes.
   */
  get connectionStatusChanged(): ManaEvent<ConnectionStatus> {
    return this.connectionStatusChangedEmitter.event;
  }

  /**
   * A signal emitted for iopub kernel messages.
   *
   * #### Notes
   * This signal is emitted after the iopub message is handled asynchronously.
   */
  get iopubMessage(): ManaEvent<KernelMessage.IIOPubMessage> {
    return this.iopubMessageEmitter.event;
  }

  get futureMessage(): ManaEvent<KernelMessage.IMessage<KernelMessage.MessageType>> {
    return this.futureMessageEmitter.event;
  }

  /**
   * A signal emitted for unhandled kernel message.
   *
   * #### Notes
   * This signal is emitted for a message that was not handled. It is emitted
   * during the asynchronous message handling code.
   */
  get unhandledMessage(): ManaEvent<KernelMessage.IMessage> {
    return this.unhandledMessageEmitter.event;
  }

  /**
   * The kernel model
   */
  get model(): IKernelModel {
    return (
      this._model || {
        id: this.id,
        name: this.name,
        reason: this._reason,
      }
    );
  }

  /**
   * A signal emitted for any kernel message.
   *
   * #### Notes
   * This signal is emitted when a message is received, before it is handled
   * asynchronously.
   *
   * This message is emitted when a message is queued for sending (either in
   * the websocket buffer, or our own pending message buffer). The message may
   * actually be sent across the wire at a later time.
   *
   * The message emitted in this signal should not be modified in any way.
   */
  get anyMessage(): ManaEvent<IAnyMessageArgs> {
    return this.anyMessageEmitter.event;
  }

  /**
   * A signal emitted when a kernel has pending inputs from the user.
   */
  get pendingInput(): ManaEvent<boolean> {
    return this.pendingInputEmitter.event;
  }

  /**
   * The id of the server-side kernel.
   */
  get id(): string {
    return this._id;
  }

  /**
   * The name of the server-side kernel.
   */
  get name(): string {
    return this._name;
  }

  /**
   * The client username.
   */
  get username(): string {
    return this._username;
  }

  /**
   * The client unique id.
   */
  get clientId(): string {
    return this._clientId;
  }

  /**
   * The current status of the kernel.
   */
  get status(): KernelMessage.Status {
    return this._status;
  }

  /**
   * The current connection status of the kernel connection.
   */
  get connectionStatus(): ConnectionStatus {
    return this._connectionStatus;
  }

  /**
   * Test whether the kernel has been disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * The cached kernel info.
   *
   * @returns A promise that resolves to the kernel info.
   */
  get info(): Promise<KernelMessage.IInfoReply> {
    return this._info.promise;
  }

  /**
   * The kernel spec.
   *
   * @returns A promise that resolves to the kernel spec.
   */
  get spec(): Promise<ISpecModel | undefined> {
    if (this._specPromise) {
      return this._specPromise;
    }
    this._specPromise = this.kernelSpecRestAPI
      .getSpecs(this.serverSettings)
      .then((specs) => {
        return specs.kernelspecs[this._name];
      });
    return this._specPromise;
  }

  /**
   * Clone the current kernel with a new clientId.
   */
  clone(
    options: Pick<
      KernelConnectionOptions,
      'clientId' | 'username' | 'handleComms'
    > = {},
  ): IKernelConnection {
    return this.libroKernelConnectionFactory({
      model: this.model,
      username: this.username,
      // handleComms defaults to false since that is safer
      handleComms: false,
      ...options,
    });
  }

  /**
   * Dispose of the resources held by the kernel.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this.onDisposedEmitter.fire();

    this._updateConnectionStatus('disconnected');
    this._clearKernelState();
    this._pendingMessages = [];
    this._clearSocket();

    this.connectionStatusChangedEmitter.dispose();
    this.statusChangedEmitter.dispose();
    this.onDisposedEmitter.dispose();
    this.iopubMessageEmitter.dispose();
    this.futureMessageEmitter.dispose();
    this.anyMessageEmitter.dispose();
    this.pendingInputEmitter.dispose();
    this.unhandledMessageEmitter.dispose();
    this._isDisposed = true;
  }

  /**
   * Send a shell message to the kernel.
   *
   * #### Notes
   * Send a message to the kernel's shell channel, yielding a future object
   * for accepting replies.
   *
   * If `expectReply` is given and `true`, the future is disposed when both a
   * shell reply and an idle status message are received. If `expectReply`
   * is not given or is `false`, the future is resolved when an idle status
   * message is received.
   * If `disposeOnDone` is not given or is `true`, the Future is disposed at this point.
   * If `disposeOnDone` is given and `false`, it is up to the caller to dispose of the Future.
   *
   * All replies are validated as valid kernel messages.
   *
   * If the kernel status is `dead`, this will throw an error.
   */
  sendShellMessage<T extends KernelMessage.ShellMessageType>(
    msg: KernelMessage.IShellMessage<T>,
    expectReply = false,
    disposeOnDone = true,
  ): IShellFuture<KernelMessage.IShellMessage<T>> {
    return this._sendKernelShellControl(
      KernelShellFutureHandler as any,
      msg,
      expectReply,
      disposeOnDone,
    ) as IShellFuture<KernelMessage.IShellMessage<T>>;
  }

  /**
   * Send a control message to the kernel.
   *
   * #### Notes
   * Send a message to the kernel's control channel, yielding a future object
   * for accepting replies.
   *
   * If `expectReply` is given and `true`, the future is disposed when both a
   * control reply and an idle status message are received. If `expectReply`
   * is not given or is `false`, the future is resolved when an idle status
   * message is received.
   * If `disposeOnDone` is not given or is `true`, the Future is disposed at this point.
   * If `disposeOnDone` is given and `false`, it is up to the caller to dispose of the Future.
   *
   * All replies are validated as valid kernel messages.
   *
   * If the kernel status is `dead`, this will throw an error.
   */
  sendControlMessage<T extends KernelMessage.ControlMessageType>(
    msg: KernelMessage.IControlMessage<T>,
    expectReply = false,
    disposeOnDone = true,
  ): IControlFuture<KernelMessage.IControlMessage<T>> {
    return this._sendKernelShellControl(
      KernelControlFutureHandler as any,
      msg,
      expectReply,
      disposeOnDone,
    ) as IControlFuture<KernelMessage.IControlMessage<T>>;
  }

  protected _sendKernelShellControl<
    REQUEST extends KernelMessage.IShellControlMessage,
    REPLY extends KernelMessage.IShellControlMessage,
    KFH extends new (...params: any[]) => KernelFutureHandler<REQUEST, REPLY>,
    T extends KernelMessage.IMessage,
  >(
    ctor: KFH,
    msg: T,
    expectReply = false,
    disposeOnDone = true,
  ): IFuture<KernelMessage.IShellControlMessage, KernelMessage.IShellControlMessage> {
    this._sendMessage(msg);
    this.anyMessageEmitter.fire({ msg, direction: 'send' });

    const future = new ctor(
      () => {
        const msgId = msg.header.msg_id;
        this._futures.delete(msgId);
        // Remove stored display id information.
        const displayIds = this._msgIdToDisplayIds.get(msgId);
        if (!displayIds) {
          return;
        }
        displayIds.forEach((displayId) => {
          const msgIds = this._displayIdToParentIds.get(displayId);
          if (msgIds) {
            const idx = msgIds.indexOf(msgId);
            if (idx === -1) {
              return;
            }
            if (msgIds.length === 1) {
              this._displayIdToParentIds.delete(displayId);
            } else {
              msgIds.splice(idx, 1);
              this._displayIdToParentIds.set(displayId, msgIds);
            }
          }
        });
        this._msgIdToDisplayIds.delete(msgId);
      },
      msg,
      expectReply,
      disposeOnDone,
      this,
    );
    this._futures.set(msg.header.msg_id, future as any);
    return future as any;
  }

  /**
   * Send a message on the websocket.
   *
   * If queue is true, queue the message for later sending if we cannot send
   * now. Otherwise throw an error.
   *
   * #### Notes
   * As an exception to the queueing, if we are sending a kernel_info_request
   * message while we think the kernel is restarting, we send the message
   * immediately without queueing. This is so that we can trigger a message
   * back, which will then clear the kernel restarting state.
   */
  protected _sendMessage(msg: KernelMessage.IMessage, queue = true) {
    if (this.status === 'dead') {
      throw new Error('Kernel is dead');
    }

    // If we have a kernel_info_request and we are starting or restarting, send the
    // kernel_info_request immediately if we can, and if not throw an error so
    // we can retry later. On restarting we do this because we must get at least one message
    // from the kernel to reset the kernel session (thus clearing the restart
    // status sentinel).
    if (
      (this._kernelSession === STARTING_KERNEL_SESSION ||
        this._kernelSession === RESTARTING_KERNEL_SESSION) &&
      isInfoRequestMsg(msg)
    ) {
      if (this.connectionStatus === 'connected') {
        this._ws!.send(serialize(msg, this._ws!.protocol));
        return;
      } else {
        throw new Error('Could not send message: status is not connected');
      }
    }

    // If there are pending messages, add to the queue so we keep messages in order
    if (queue && this._pendingMessages.length > 0) {
      this._pendingMessages.push(msg);
      return;
    }

    // Send if the ws allows it, otherwise queue the message.
    if (
      this.connectionStatus === 'connected' &&
      this._kernelSession !== RESTARTING_KERNEL_SESSION
    ) {
      this._ws!.send(serialize(msg, this._ws!.protocol));
    } else if (queue) {
      this._pendingMessages.push(msg);
    } else {
      throw new Error('Could not send message');
    }
  }

  /**
   * Interrupt a kernel.
   *
   * #### Notes
   * Uses the [Jupyter Notebook API](http://petstore.swagger.io/?url=https://raw.githubusercontent.com/jupyter/notebook/master/notebook/services/api/api.yaml#!/kernels).
   *
   * The promise is fulfilled on a valid response and rejected otherwise.
   *
   * It is assumed that the API call does not mutate the kernel id or name.
   *
   * The promise will be rejected if the kernel status is `Dead` or if the
   * request fails or the response is invalid.
   */
  async interrupt(): Promise<void> {
    this.hasPendingInput = false;
    if (this.status === 'dead') {
      throw new Error('Kernel is dead');
    }
    return this.kernelRestAPI.interruptKernel(this.id, this.serverSettings);
  }

  /**
   * Request a kernel restart.
   *
   * #### Notes
   * Uses the [Jupyter Notebook API](http://petstore.swagger.io/?url=https://raw.githubusercontent.com/jupyter/notebook/master/notebook/services/api/api.yaml#!/kernels)
   * and validates the response model.
   *
   * Any existing Future or Comm objects are cleared once the kernel has
   * actually be restarted.
   *
   * The promise is fulfilled on a valid server response (after the kernel restarts)
   * and rejected otherwise.
   *
   * It is assumed that the API call does not mutate the kernel id or name.
   *
   * The promise will be rejected if the request fails or the response is
   * invalid.
   */
  async restart(): Promise<void> {
    if (this.status === 'dead') {
      throw new Error('Kernel is dead');
    }
    this._updateStatus('restarting');
    this._clearKernelState();
    this._kernelSession = RESTARTING_KERNEL_SESSION;
    await this.kernelRestAPI.restartKernel(this.id, this.serverSettings);
    // Reconnect to the kernel to address cases where kernel ports
    // have changed during the restart.
    await this.reconnect();
    this.hasPendingInput = false;
  }

  /**
   * Reconnect to a kernel.
   *
   * #### Notes
   * This may try multiple times to reconnect to a kernel, and will sever any
   * existing connection.
   */
  reconnect(): Promise<void> {
    this._errorIfDisposed();
    const result = new Deferred<void>();
    let toDispose: Disposable | undefined = undefined;

    // Set up a listener for the connection status changing, which accepts or
    // rejects after the retries are done.
    const fulfill = (status: ConnectionStatus) => {
      if (status === 'connected') {
        result.resolve();
        if (toDispose) {
          toDispose.dispose();
          toDispose = undefined;
        }
      } else if (status === 'disconnected') {
        result.reject(new Error('Kernel connection disconnected'));
        if (toDispose) {
          toDispose.dispose();
          toDispose = undefined;
        }
      }
    };
    toDispose = this.connectionStatusChanged(fulfill);

    // Reset the reconnect limit so we start the connection attempts fresh
    this._reconnectAttempt = 0;

    // Start the reconnection process, which will also clear any existing
    // connection.
    this._reconnect();

    // Return the promise that should resolve on connection or reject if the
    // retries don't work.
    return result.promise;
  }

  /**
   * Shutdown a kernel.
   *
   * #### Notes
   * Uses the [Jupyter Notebook API](http://petstore.swagger.io/?url=https://raw.githubusercontent.com/jupyter/notebook/master/notebook/services/api/api.yaml#!/kernels).
   *
   * The promise is fulfilled on a valid response and rejected otherwise.
   *
   * On a valid response, disposes this kernel connection.
   *
   * If the kernel is already `dead`, disposes this kernel connection without
   * a server request.
   */
  async shutdown(): Promise<void> {
    if (this.status !== 'dead') {
      await this.kernelRestAPI.shutdownKernel(this.id, this.serverSettings);
    }
    this.handleShutdown();
  }

  /**
   * Handles a kernel shutdown.
   *
   * #### Notes
   * This method should be called if we know from outside information that a
   * kernel is dead (for example, we cannot find the kernel model on the
   * server).
   */
  handleShutdown(): void {
    this._updateStatus('dead');
    this.dispose();
  }

  /**
   * Send a `kernel_info_request` message.
   *
   * #### Notes
   * See [Messaging in Jupyter](https://jupyter-client.readthedocs.io/en/latest/messaging.html#kernel-info).
   *
   * Fulfills with the `kernel_info_response` content when the shell reply is
   * received and validated.
   */
  async requestKernelInfo(): Promise<KernelMessage.IInfoReplyMsg | undefined> {
    const msg = KernelMessage.createMessage({
      msgType: 'kernel_info_request',
      channel: 'shell',
      username: this._username,
      session: this._clientId,
      content: {},
    });
    let reply: KernelMessage.IInfoReplyMsg | undefined;
    try {
      reply = (await Private.handleShellMessage(this, msg)) as
        | KernelMessage.IInfoReplyMsg
        | undefined;
    } catch (e) {
      // If we rejected because the future was disposed, ignore and return.
      if (this.isDisposed) {
        return;
      } else {
        throw e;
      }
    }
    this._errorIfDisposed();

    if (!reply) {
      return;
    }

    // Kernels sometimes do not include a status field on kernel_info_reply
    // messages, so set a default for now.
    // See https://github.com/jupyterlab/jupyterlab/issues/6760
    if (reply.content.status === undefined) {
      (reply.content as any).status = 'ok';
    }

    if (reply.content.status !== 'ok') {
      this._info.reject('Kernel info reply errored');
      return reply;
    }

    this._info.resolve(reply.content);

    this._kernelSession = reply.header.session;

    return reply;
  }

  /**
   * Send a `complete_request` message.
   *
   * #### Notes
   * See [Messaging in Jupyter](https://jupyter-client.readthedocs.io/en/latest/messaging.html#completion).
   *
   * Fulfills with the `complete_reply` content when the shell reply is
   * received and validated.
   */
  requestComplete(
    content: KernelMessage.ICompleteRequestMsg['content'],
  ): Promise<KernelMessage.ICompleteReplyMsg> {
    const msg = KernelMessage.createMessage({
      msgType: 'complete_request',
      channel: 'shell',
      username: this._username,
      session: this._clientId,
      content,
    });
    return Private.handleShellMessage(
      this,
      msg,
    ) as Promise<KernelMessage.ICompleteReplyMsg>;
  }

  /**
   * Send an `inspect_request` message.
   *
   * #### Notes
   * See [Messaging in Jupyter](https://jupyter-client.readthedocs.io/en/latest/messaging.html#introspection).
   *
   * Fulfills with the `inspect_reply` content when the shell reply is
   * received and validated.
   */
  requestInspect(
    content: KernelMessage.IInspectRequestMsg['content'],
  ): Promise<KernelMessage.IInspectReplyMsg> {
    const msg = KernelMessage.createMessage({
      msgType: 'inspect_request',
      channel: 'shell',
      username: this._username,
      session: this._clientId,
      content: content,
    });
    return Private.handleShellMessage(
      this,
      msg,
    ) as Promise<KernelMessage.IInspectReplyMsg>;
  }

  /**
   * Send a `history_request` message.
   *
   * #### Notes
   * See [Messaging in Jupyter](https://jupyter-client.readthedocs.io/en/latest/messaging.html#history).
   *
   * Fulfills with the `history_reply` content when the shell reply is
   * received and validated.
   */
  requestHistory(
    content: KernelMessage.IHistoryRequestMsg['content'],
  ): Promise<KernelMessage.IHistoryReplyMsg> {
    const msg = KernelMessage.createMessage({
      msgType: 'history_request',
      channel: 'shell',
      username: this._username,
      session: this._clientId,
      content,
    });
    return Private.handleShellMessage(
      this,
      msg,
    ) as Promise<KernelMessage.IHistoryReplyMsg>;
  }

  /**
   * Send an `execute_request` message.
   *
   * #### Notes
   * See [Messaging in Jupyter](https://jupyter-client.readthedocs.io/en/latest/messaging.html#execute).
   *
   * Future `onReply` is called with the `execute_reply` content when the
   * shell reply is received and validated. The future will resolve when
   * this message is received and the `idle` iopub status is received.
   * The future will also be disposed at this point unless `disposeOnDone`
   * is specified and `false`, in which case it is up to the caller to dispose
   * of the future.
   *
   * **See also:** [[IExecuteReply]]
   */
  requestExecute(
    content: KernelMessage.IExecuteRequestMsg['content'],
    disposeOnDone = true,
    metadata?: JSONObject,
  ): IShellFuture<KernelMessage.IExecuteRequestMsg, KernelMessage.IExecuteReplyMsg> {
    const defaults: JSONObject = {
      silent: false,
      store_history: true,
      user_expressions: {},
      allow_stdin: true,
      stop_on_error: true,
    };
    const msg = KernelMessage.createMessage({
      msgType: 'execute_request',
      channel: 'shell',
      username: this._username,
      session: this._clientId,
      content: { ...defaults, ...content },
      metadata,
    });
    return this.sendShellMessage(msg, true, disposeOnDone) as IShellFuture<
      KernelMessage.IExecuteRequestMsg,
      KernelMessage.IExecuteReplyMsg
    >;
  }

  /**
   * Send an experimental `debug_request` message.
   *
   * @hidden
   *
   * #### Notes
   * Debug messages are experimental messages that are not in the official
   * kernel message specification. As such, this function is *NOT* considered
   * part of the public API, and may change without notice.
   */
  requestDebug(
    content: KernelMessage.IDebugRequestMsg['content'],
    disposeOnDone = true,
  ): IControlFuture<KernelMessage.IDebugRequestMsg, KernelMessage.IDebugReplyMsg> {
    const msg = KernelMessage.createMessage({
      msgType: 'debug_request',
      channel: 'control',
      username: this._username,
      session: this._clientId,
      content,
    });
    return this.sendControlMessage(msg, true, disposeOnDone) as IControlFuture<
      KernelMessage.IDebugRequestMsg,
      KernelMessage.IDebugReplyMsg
    >;
  }

  /**
   * Send an `is_complete_request` message.
   *
   * #### Notes
   * See [Messaging in Jupyter](https://jupyter-client.readthedocs.io/en/latest/messaging.html#code-completeness).
   *
   * Fulfills with the `is_complete_response` content when the shell reply is
   * received and validated.
   */
  requestIsComplete(
    content: KernelMessage.IIsCompleteRequestMsg['content'],
  ): Promise<KernelMessage.IIsCompleteReplyMsg> {
    const msg = KernelMessage.createMessage({
      msgType: 'is_complete_request',
      channel: 'shell',
      username: this._username,
      session: this._clientId,
      content,
    });
    return Private.handleShellMessage(
      this,
      msg,
    ) as Promise<KernelMessage.IIsCompleteReplyMsg>;
  }

  /**
   * Send a `comm_info_request` message.
   *
   * #### Notes
   * Fulfills with the `comm_info_reply` content when the shell reply is
   * received and validated.
   */
  requestCommInfo(
    content: KernelMessage.ICommInfoRequestMsg['content'],
  ): Promise<KernelMessage.ICommInfoReplyMsg> {
    const msg = KernelMessage.createMessage({
      msgType: 'comm_info_request',
      channel: 'shell',
      username: this._username,
      session: this._clientId,
      content,
    });
    return Private.handleShellMessage(
      this,
      msg,
    ) as Promise<KernelMessage.ICommInfoReplyMsg>;
  }

  /**
   * Send an `input_reply` message.
   *
   * #### Notes
   * See [Messaging in Jupyter](https://jupyter-client.readthedocs.io/en/latest/messaging.html#messages-on-the-stdin-router-dealer-sockets).
   */
  sendInputReply(
    content: KernelMessage.IInputReplyMsg['content'],
    parent_header: KernelMessage.IInputReplyMsg['parent_header'],
  ): void {
    const msg = KernelMessage.createMessage({
      msgType: 'input_reply',
      channel: 'stdin',
      username: this._username,
      session: this._clientId,
      content,
    });
    msg.parent_header = parent_header;

    this._sendMessage(msg);
    this.anyMessageEmitter.fire({ msg, direction: 'send' });

    this.hasPendingInput = false;
  }

  /**
   * Create a new comm.
   *
   * #### Notes
   * If a client-side comm already exists with the given commId, an error is thrown.
   * If the kernel does not handle comms, an error is thrown.
   */
  createComm(targetName: string, commId: string = v4()): IComm {
    if (!this.handleComms) {
      throw new Error('Comms are disabled on this kernel connection');
    }
    if (this._comms.has(commId)) {
      throw new Error('Comm is already created');
    }

    const comm = new CommHandler(targetName, commId, this, () => {
      this._unregisterComm(commId);
    });
    this._comms.set(commId, comm);
    return comm;
  }

  /**
   * Check if a comm exists.
   */
  hasComm(commId: string): boolean {
    return this._comms.has(commId);
  }

  /**
   * Register a comm target handler.
   *
   * @param targetName - The name of the comm target.
   *
   * @param callback - The callback invoked for a comm open message.
   *
   * @returns A disposable used to unregister the comm target.
   *
   * #### Notes
   * Only one comm target can be registered to a target name at a time, an
   * existing callback for the same target name will be overridden.  A registered
   * comm target handler will take precedence over a comm which specifies a
   * `target_module`.
   *
   * If the callback returns a promise, kernel message processing will pause
   * until the returned promise is fulfilled.
   */
  registerCommTarget(
    targetName: string,
    callback: (
      comm: IComm,
      msg: KernelMessage.ICommOpenMsg,
    ) => void | PromiseLike<void>,
  ): void {
    if (!this.handleComms) {
      return;
    }

    this._targetRegistry[targetName] = callback;
  }

  /**
   * Remove a comm target handler.
   *
   * @param targetName - The name of the comm target to remove.
   *
   * @param callback - The callback to remove.
   *
   * #### Notes
   * The comm target is only removed if the callback argument matches.
   */
  removeCommTarget(
    targetName: string,
    callback: (
      comm: IComm,
      msg: KernelMessage.ICommOpenMsg,
    ) => void | PromiseLike<void>,
  ): void {
    if (!this.handleComms) {
      return;
    }

    if (!this.isDisposed && this._targetRegistry[targetName] === callback) {
      delete this._targetRegistry[targetName];
    }
  }

  /**
   * Register an IOPub message hook.
   *
   * @param msg_id - The parent_header message id the hook will intercept.
   *
   * @param hook - The callback invoked for the message.
   *
   * #### Notes
   * The IOPub hook system allows you to preempt the handlers for IOPub
   * messages that are responses to a given message id.
   *
   * The most recently registered hook is run first. A hook can return a
   * boolean or a promise to a boolean, in which case all kernel message
   * processing pauses until the promise is fulfilled. If a hook return value
   * resolves to false, any later hooks will not run and the function will
   * return a promise resolving to false. If a hook throws an error, the error
   * is logged to the console and the next hook is run. If a hook is
   * registered during the hook processing, it will not run until the next
   * message. If a hook is removed during the hook processing, it will be
   * deactivated immediately.
   *
   * See also [[IFuture.registerMessageHook]].
   */
  registerMessageHook(
    msgId: string,
    hook: (msg: KernelMessage.IIOPubMessage) => boolean | PromiseLike<boolean>,
  ): Disposable {
    const future = this._futures?.get(msgId);
    if (future) {
      return future.registerMessageHook(hook);
    }
    return Disposable.NONE;
  }

  /**
   * Remove an IOPub message hook.
   *
   * @param msg_id - The parent_header message id the hook intercepted.
   *
   * @param hook - The callback invoked for the message.
   *
   */
  removeMessageHook(
    msgId: string,
    hook: (msg: KernelMessage.IIOPubMessage) => boolean | PromiseLike<boolean>,
  ): void {
    const future = this._futures?.get(msgId);
    if (future) {
      future.removeMessageHook(hook);
    }
  }

  /**
   * Remove the input guard, if any.
   */
  removeInputGuard() {
    this.hasPendingInput = false;
  }

  /**
   * Handle a message with a display id.
   *
   * @returns Whether the message was handled.
   */
  protected async _handleDisplayId(
    displayId: string,
    msg: KernelMessage.IMessage,
  ): Promise<boolean> {
    const msgId = (msg.parent_header as KernelMessage.IHeader).msg_id;
    let parentIds = this._displayIdToParentIds.get(displayId);
    if (parentIds) {
      // We've seen it before, update existing outputs with same display_id
      // by handling display_data as update_display_data.
      const updateMsg: KernelMessage.IMessage = {
        header: deepCopy(
          msg.header as unknown as JSONObject,
        ) as unknown as KernelMessage.IHeader,
        parent_header: deepCopy(
          msg.parent_header as unknown as JSONObject,
        ) as unknown as KernelMessage.IHeader,
        metadata: deepCopy(msg.metadata),
        content: deepCopy(msg.content as JSONObject),
        channel: msg.channel,
        buffers: msg.buffers ? msg.buffers.slice() : [],
      };
      (updateMsg.header as any).msg_type = 'update_display_data';

      await Promise.all(
        parentIds.map(async (parentId) => {
          const future = this._futures && this._futures.get(parentId);
          if (future) {
            await future.handleMsg(updateMsg);
          }
        }),
      );
    }

    // We're done here if it's update_display.
    if (msg.header.msg_type === 'update_display_data') {
      // It's an update, don't proceed to the normal display.
      return true;
    }

    // Regular display_data with id, record it for future updating
    // in _displayIdToParentIds for future lookup.
    parentIds = this._displayIdToParentIds.get(displayId) ?? [];
    if (parentIds.indexOf(msgId) === -1) {
      parentIds.push(msgId);
    }
    this._displayIdToParentIds.set(displayId, parentIds);

    // Add to our map of display ids for this message.
    const displayIds = this._msgIdToDisplayIds.get(msgId) ?? [];
    if (displayIds.indexOf(msgId) === -1) {
      displayIds.push(msgId);
    }
    this._msgIdToDisplayIds.set(msgId, displayIds);

    // Let the message propagate to the intended recipient.
    return false;
  }

  /**
   * Forcefully clear the socket state.
   *
   * #### Notes
   * This will clear all socket state without calling any handlers and will
   * not update the connection status. If you call this method, you are
   * responsible for updating the connection status as needed and recreating
   * the socket if you plan to reconnect.
   */
  protected _clearSocket = (): void => {
    if (this._ws !== null) {
      // Clear the websocket event handlers and the socket itself.
      this._ws.onopen = this._noOp;
      this._ws.onclose = this._noOp;
      this._ws.onerror = this._noOp;
      this._ws.onmessage = this._noOp;
      this._ws.close();
      this._ws = null;
    }
  };

  /**
   * Handle status iopub messages from the kernel.
   */
  protected _updateStatus(status: KernelMessage.Status): void {
    if (this._status === status || this._status === 'dead') {
      return;
    }

    this._status = status;
    Private.logKernelStatus(this);
    this.statusChangedEmitter.fire(status);
    if (status === 'dead') {
      this.dispose();
    }
  }

  /**
   * Send pending messages to the kernel.
   */
  protected _sendPending(): void {
    // We check to make sure we are still connected each time. For
    // example, if a websocket buffer overflows, it may close, so we should
    // stop sending messages.
    while (
      this.connectionStatus === 'connected' &&
      this._kernelSession !== RESTARTING_KERNEL_SESSION &&
      this._pendingMessages.length > 0
    ) {
      this._sendMessage(this._pendingMessages[0], false);

      // We shift the message off the queue after the message is sent so that
      // if there is an exception, the message is still pending.
      this._pendingMessages.shift();
    }
  }

  /**
   * Clear the internal state.
   */
  protected _clearKernelState(): void {
    this._kernelSession = '';
    this._pendingMessages = [];
    this._futures.forEach((future) => {
      future.dispose();
    });
    this._comms.forEach((comm) => {
      comm.dispose();
    });
    this._msgChain = Promise.resolve();
    this._futures = new Map<
      string,
      KernelFutureHandler<
        KernelMessage.IShellControlMessage,
        KernelMessage.IShellControlMessage
      >
    >();
    this._comms = new Map<string, IComm>();
    this._displayIdToParentIds.clear();
    this._msgIdToDisplayIds.clear();
  }

  /**
   * Check to make sure it is okay to proceed to handle a message.
   *
   * #### Notes
   * Because we handle messages asynchronously, before a message is handled the
   * kernel might be disposed or restarted (and have a different session id).
   * This function throws an error in each of these cases. This is meant to be
   * called at the start of an asynchronous message handler to cancel message
   * processing if the message no longer is valid.
   */
  protected _assertCurrentMessage(msg: KernelMessage.IMessage) {
    this._errorIfDisposed();

    if (msg.header.session !== this._kernelSession) {
      throw new Error(`Canceling handling of old message: ${msg.header.msg_type}`);
    }
  }

  /**
   * Handle a `comm_open` kernel message.
   */
  protected async _handleCommOpen(msg: KernelMessage.ICommOpenMsg): Promise<void> {
    this._assertCurrentMessage(msg);
    const content = msg.content;
    const comm = new CommHandler(content.target_name, content.comm_id, this, () => {
      this._unregisterComm(content.comm_id);
    });
    this._comms.set(content.comm_id, comm);

    try {
      const target = await Private.loadObject(
        content.target_name,
        content.target_module,
        this._targetRegistry,
      );
      await target(comm, msg);
    } catch (e) {
      // Close the comm asynchronously. We cannot block message processing on
      // kernel messages to wait for another kernel message.
      comm.close();
      console.error('Exception opening new comm', e);
      throw e;
    }
  }

  /**
   * Handle 'comm_close' kernel message.
   */
  protected async _handleCommClose(msg: KernelMessage.ICommCloseMsg): Promise<void> {
    this._assertCurrentMessage(msg);
    const content = msg.content;
    const comm = this._comms.get(content.comm_id);
    if (!comm) {
      console.error('Comm not found for comm id ' + content.comm_id);
      return;
    }
    this._unregisterComm(comm.commId);
    const onClose = comm.onClose;
    if (onClose) {
      // tslint:disable-next-line:await-promise
      await onClose(msg);
    }
    (comm as CommHandler).dispose();
  }

  /**
   * Handle a 'comm_msg' kernel message.
   */
  protected async _handleCommMsg(msg: KernelMessage.ICommMsgMsg): Promise<void> {
    this._assertCurrentMessage(msg);
    const content = msg.content;
    const comm = this._comms.get(content.comm_id);
    if (!comm) {
      return;
    }
    const onMsg = comm.onMsg;
    if (onMsg) {
      await onMsg(msg);
    }
  }

  /**
   * Unregister a comm instance.
   */
  protected _unregisterComm(commId: string) {
    this._comms.delete(commId);
  }

  /**
   * Create the kernel websocket connection and add socket status handlers.
   */
  protected _createSocket = (useProtocols = false) => {
    this._errorIfDisposed();

    // Make sure the socket is clear
    this._clearSocket();

    // Update the connection status to reflect opening a new connection.
    this._updateConnectionStatus('connecting');

    const settings = this.serverSettings;

    const partialUrl = URL.join(
      settings.wsUrl,
      restapi.KERNEL_SERVICE_URL,
      encodeURIComponent(this._id),
    );

    // Strip any authentication from the display string.
    // eslint-disable-next-line no-useless-escape
    const display = partialUrl.replace(/^((?:\w+:)?\/\/)(?:[^@\/]+@)/, '$1');
    // eslint-disable-next-line no-console
    console.debug(`Starting WebSocket: ${display}`);

    let url = URL.join(
      partialUrl,
      'channels?session_id=' + encodeURIComponent(this._clientId),
    );

    // If token authentication is in use.
    const token = settings.token;
    if (settings.appendToken && token !== '') {
      url = url + `&token=${encodeURIComponent(token)}`;
    }

    // Try opening the websocket with our list of subprotocols.
    // If the server doesn't handle subprotocols,
    // the accepted protocol will be ''.
    // But we cannot send '' as a subprotocol, so if connection fails,
    // reconnect without subprotocols.
    const supportedProtocols = useProtocols ? this._supportedProtocols : [];
    this._ws = new settings.WebSocket(url, supportedProtocols);

    // Ensure incoming binary messages are not Blobs
    this._ws.binaryType = 'arraybuffer';

    let alreadyCalledOnclose = false;

    const getKernelModel = async (evt: Event) => {
      if (this._isDisposed) {
        return;
      }
      this._reason = '';
      this._model = undefined;
      try {
        const model = await this.kernelRestAPI.getKernelModel(this._id, settings);
        this._model = model;
        if (model?.execution_state === 'dead') {
          this._updateStatus('dead');
        } else {
          this._onWSClose(evt);
        }
      } catch (err: any) {
        // Try again, if there is a network failure
        // Handle network errors, as well as cases where we are on a
        // JupyterHub and the server is not running. JupyterHub returns a
        // 503 (<2.0) or 424 (>2.0) in that case.
        if (
          err instanceof NetworkError ||
          err.response?.status === 503 ||
          err.response?.status === 424
        ) {
          const timeout = Private.getRandomIntInclusive(10, 30) * 1e3;
          setTimeout(getKernelModel, timeout, evt);
        } else {
          this._reason = 'Kernel died unexpectedly';
          this._updateStatus('dead');
        }
      }
      return;
    };

    const earlyClose = async (evt: Event) => {
      // If the websocket was closed early, that could mean
      // that the kernel is actually dead. Try getting
      // information about the kernel from the API call,
      // if that fails, then assume the kernel is dead,
      // otherwise just follow the typical websocket closed
      // protocol.
      if (alreadyCalledOnclose) {
        return;
      }
      alreadyCalledOnclose = true;
      await getKernelModel(evt);

      return;
    };

    this._ws.onmessage = this._onWSMessage;
    this._ws.onopen = this._onWSOpen;
    this._ws.onclose = earlyClose;
    this._ws.onerror = earlyClose;
  };

  /**
   * Handle connection status changes.
   */
  protected _updateConnectionStatus(connectionStatus: ConnectionStatus): void {
    if (this._connectionStatus === connectionStatus) {
      return;
    }

    this._connectionStatus = connectionStatus;

    // If we are not 'connecting', reset any reconnection attempts.
    if (connectionStatus !== 'connecting') {
      this._reconnectAttempt = 0;
      clearTimeout(this._reconnectTimeout);
    }

    if (this.status !== 'dead') {
      if (connectionStatus === 'connected') {
        const restarting = this._kernelSession === RESTARTING_KERNEL_SESSION;

        // Send a kernel info request to make sure we send at least one
        // message to get kernel status back. Always request kernel info
        // first, to get kernel status back and ensure iopub is fully
        // established. If we are restarting, this message will skip the queue
        // and be sent immediately.
        const p = this.requestKernelInfo();

        // Send any pending messages after the kernelInfo resolves, or after a
        // timeout as a failsafe.

        let sendPendingCalled = false;
        let timeoutHandle: any = null;
        const sendPendingOnce = () => {
          if (sendPendingCalled) {
            return;
          }
          sendPendingCalled = true;
          if (restarting && this._kernelSession === RESTARTING_KERNEL_SESSION) {
            // We were restarting and a message didn't arrive to set the
            // session, but we just assume the restart succeeded and send any
            // pending messages.

            // FIXME: it would be better to retry the kernel_info_request here
            this._kernelSession = '';
          }
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }
          if (this._pendingMessages.length > 0) {
            this._sendPending();
          }
        };
        void p.then(sendPendingOnce);
        // FIXME: if sent while zmq subscriptions are not established,
        // kernelInfo may not resolve, so use a timeout to ensure we don't hang forever.
        // It may be preferable to retry kernelInfo rather than give up after one timeout.
        timeoutHandle = setTimeout(sendPendingOnce, KERNEL_INFO_TIMEOUT);
      } else {
        // If the connection is down, then we do not know what is happening
        // with the kernel, so set the status to unknown.
        this._updateStatus('unknown');
      }
    }

    // Notify others that the connection status changed.
    this.connectionStatusChangedEmitter.fire(connectionStatus);
  }

  protected async _handleMessage(msg: KernelMessage.IMessage): Promise<void> {
    let handled = false;

    // Check to see if we have a display_id we need to reroute.
    if (
      msg.parent_header &&
      msg.channel === 'iopub' &&
      (isDisplayDataMsg(msg) || isUpdateDisplayDataMsg(msg) || isExecuteResultMsg(msg))
    ) {
      // display_data messages may re-route based on their display_id.
      const _transient = (msg.content.transient ?? {}) as JSONObject;
      const displayId = _transient['display_id'] as string;
      if (displayId) {
        handled = await this._handleDisplayId(displayId, msg);
        // The await above may make this message out of date, so check again.
        this._assertCurrentMessage(msg);
      }
    }

    if (!handled && msg.parent_header) {
      const parentHeader = msg.parent_header as KernelMessage.IHeader;
      const future = this._futures?.get(parentHeader.msg_id);
      if (future) {
        await future.handleMsg(msg);
        this.futureMessageEmitter.fire(msg);
        this._assertCurrentMessage(msg);
      } else {
        // If the message was sent by us and was not iopub, it is orphaned.
        const owned = parentHeader.session === this.clientId;
        if (msg.channel !== 'iopub' && owned) {
          this.unhandledMessageEmitter.fire(msg);
        }
      }
    }
    if (msg.channel === 'iopub') {
      switch (msg.header.msg_type) {
        case 'status': {
          // Updating the status is synchronous, and we call no async user code
          const executionState = (msg as KernelMessage.IStatusMsg).content
            .execution_state;
          if (executionState === 'restarting') {
            // The kernel has been auto-restarted by the server. After
            // processing for this message is completely done, we want to
            // handle this restart, so we don't await, but instead schedule
            // the work as a microtask (i.e., in a promise resolution). We
            // schedule this here so that it comes before any microtasks that
            // might be scheduled in the status signal emission below.
            void Promise.resolve().then(async () => {
              this._updateStatus('autorestarting');
              this._clearKernelState();

              // We must reconnect since the kernel connection information may have
              // changed, and the server only refreshes its zmq connection when a new
              // websocket is opened.
              await this.reconnect();
              return;
            });
          }
          this._updateStatus(executionState);
          break;
        }
        case 'comm_open':
          if (this.handleComms) {
            await this._handleCommOpen(msg as KernelMessage.ICommOpenMsg);
          }
          break;
        case 'comm_msg':
          if (this.handleComms) {
            await this._handleCommMsg(msg as KernelMessage.ICommMsgMsg);
          }
          break;
        case 'comm_close':
          if (this.handleComms) {
            await this._handleCommClose(msg as KernelMessage.ICommCloseMsg);
          }
          break;
        default:
          break;
      }
      // If the message was a status dead message, we might have disposed ourselves.
      if (!this.isDisposed) {
        this._assertCurrentMessage(msg);
        // the message wouldn't be emitted if we were disposed anyway.
        this.iopubMessageEmitter.fire(msg as KernelMessage.IIOPubMessage);
      }
    }
  }

  /**
   * Attempt a connection if we have not exhausted connection attempts.
   */
  protected _reconnect() {
    this._errorIfDisposed();

    // Clear any existing reconnection attempt
    clearTimeout(this._reconnectTimeout);

    // Update the connection status and schedule a possible reconnection.
    if (this._reconnectAttempt < this._reconnectLimit) {
      this._updateConnectionStatus('connecting');

      // The first reconnect attempt should happen immediately, and subsequent
      // attempts should pick a random number in a growing range so that we
      // don't overload the server with synchronized reconnection attempts
      // across multiple kernels.
      const timeout = Private.getRandomIntInclusive(
        0,
        1e3 * (Math.pow(2, this._reconnectAttempt) - 1),
      );
      console.warn(
        `Connection lost, reconnecting in ${Math.floor(timeout / 1000)} seconds.`,
      );
      // Try reconnection with subprotocols if the server had supported them.
      // Otherwise, try reconnection without subprotocols.
      const useProtocols = this._selectedProtocol !== '' ? true : false;
      this._reconnectTimeout = setTimeout(this._createSocket, timeout, useProtocols);
      this._reconnectAttempt += 1;
    } else {
      this._updateConnectionStatus('disconnected');
    }

    // Clear the websocket event handlers and the socket itself.
    this._clearSocket();
  }

  /**
   * Utility function to throw an error if this instance is disposed.
   */
  protected _errorIfDisposed() {
    if (this.isDisposed) {
      throw new Error('Kernel connection is disposed');
    }
  }

  // Make websocket callbacks arrow functions so they bind `this`.

  /**
   * Handle a websocket open event.
   */
  protected _onWSOpen = () => {
    if (
      this._ws!.protocol !== '' &&
      !this._supportedProtocols.includes(this._ws!.protocol)
    ) {
      console.warn('Server selected unknown kernel wire protocol:', this._ws!.protocol);
      this._updateStatus('dead');
      throw new Error(`Unknown kernel wire protocol:  ${this._ws!.protocol}`);
    }
    // Remember the kernel wire protocol selected by the server.
    this._selectedProtocol = this._ws!.protocol;
    this._ws!.onclose = this._onWSClose;
    this._ws!.onerror = this._onWSClose;
    this._updateConnectionStatus('connected');
  };

  /**
   * Handle a websocket message, validating and routing appropriately.
   */
  protected _onWSMessage = (evt: MessageEvent) => {
    // Notify immediately if there is an error with the message.
    let msg: KernelMessage.IMessage;
    try {
      msg = deserialize(evt.data, this._ws!.protocol);
      validate.validateMessage(msg);
    } catch (error: any) {
      error.message = `Kernel message validation error: ${error.message}`;
      // We throw the error so that it bubbles up to the top, and displays the right stack.
      throw error;
    }

    // Update the current kernel session id
    this._kernelSession = msg.header.session;

    // Handle the message asynchronously, in the order received.
    this._msgChain = this._msgChain
      .then(() => {
        // Return so that any promises from handling a message are fulfilled
        // before proceeding to the next message.
        return this._handleMessage(msg);
      })
      .catch((error) => {
        // Log any errors in handling the message, thus resetting the _msgChain
        // promise so we can process more messages.
        // Ignore the "Canceled" errors that are thrown during kernel dispose.
        if (error.message.startsWith('Canceled future for ')) {
          console.error(error);
        }
      });

    // Emit the message receive signal
    this.anyMessageEmitter.fire({ msg, direction: 'recv' });
  };

  /**
   * Handle a websocket close event.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected _onWSClose = (_evt: Event) => {
    if (!this.isDisposed) {
      this._reconnect();
    }
  };

  get hasPendingInput(): boolean {
    return this._hasPendingInput;
  }
  set hasPendingInput(value: boolean) {
    this._hasPendingInput = value;
    this.pendingInputEmitter.fire(value);
  }

  protected _id = '';
  protected _name = '';
  protected _model: IKernelModel | undefined;
  @prop()
  protected _status: KernelMessage.Status = 'unknown';
  protected _connectionStatus: ConnectionStatus = 'connecting';
  protected _kernelSession = '';
  protected _clientId: string;
  protected _isDisposed = false;
  /**
   * Websocket to communicate with kernel.
   */
  protected _ws: WebSocket | null = null;
  protected _username = '';
  protected _reconnectLimit = 7;
  protected _reconnectAttempt = 0;
  protected _reconnectTimeout: any = null;
  protected _supportedProtocols: string[] = Object.values(
    KernelMessage.supportedKernelWebSocketProtocols,
  );
  protected _selectedProtocol = '';

  protected _futures = new Map<
    string,
    KernelFutureHandler<
      KernelMessage.IShellControlMessage,
      KernelMessage.IShellControlMessage
    >
  >();
  protected _comms = new Map<string, IComm>();
  protected _targetRegistry: Record<
    string,
    (comm: IComm, msg: KernelMessage.ICommOpenMsg) => void
  > = Object.create(null);
  protected _info = new Deferred<KernelMessage.IInfoReply>();
  protected _pendingMessages: KernelMessage.IMessage[] = [];
  protected _specPromise: Promise<ISpecModel | undefined>;
  protected statusChangedEmitter = new Emitter<KernelMessage.Status>();
  protected connectionStatusChangedEmitter = new Emitter<ConnectionStatus>();
  protected onDisposedEmitter = new Emitter<void>();
  protected iopubMessageEmitter = new Emitter<KernelMessage.IIOPubMessage>();
  protected futureMessageEmitter = new Emitter<
    KernelMessage.IMessage<KernelMessage.MessageType>
  >();
  protected anyMessageEmitter = new Emitter<IAnyMessageArgs>();
  protected pendingInputEmitter = new Emitter<boolean>();
  protected unhandledMessageEmitter = new Emitter<KernelMessage.IMessage>();
  protected _displayIdToParentIds = new Map<string, string[]>();
  protected _msgIdToDisplayIds = new Map<string, string[]>();
  protected _msgChain: Promise<void> = Promise.resolve();
  protected _hasPendingInput = false;
  protected _reason = '';
  protected _noOp = () => {
    /* no-op */
  };
}
