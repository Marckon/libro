/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

import { Emitter as EventEmitter } from '@difizen/libro-common/common';
import type {
  ClientCapabilities,
  CancellationToken,
  ServerCapabilities,
  DocumentSelector,
  CodeLensOptions,
  CodeLensRegistrationOptions,
} from '@difizen/vscode-languageserver-protocol';
import {
  CodeLensRequest,
  CodeLensRefreshRequest,
  CodeLensResolveRequest,
} from '@difizen/vscode-languageserver-protocol';
import type {
  Disposable,
  TextDocument,
  ProviderResult,
  CodeLensProvider,
  CodeLens as VCodeLens,
} from 'vscode';

import type { FeatureClient } from './features.js';
import { TextDocumentLanguageFeature, ensure } from './features.js';
import * as UUID from './utils/uuid.js';
import { languages as Languages } from './vscodeAdaptor/vscodeAdaptor.js';

export interface ProvideCodeLensesSignature {
  (
    this: void,
    document: TextDocument,
    token: CancellationToken,
  ): ProviderResult<VCodeLens[]>;
}

export interface ResolveCodeLensSignature {
  (
    this: void,
    codeLens: VCodeLens,
    token: CancellationToken,
  ): ProviderResult<VCodeLens>;
}

export interface CodeLensMiddleware {
  provideCodeLenses?: (
    this: void,
    document: TextDocument,
    token: CancellationToken,
    next: ProvideCodeLensesSignature,
  ) => ProviderResult<VCodeLens[]>;
  resolveCodeLens?: (
    this: void,
    codeLens: VCodeLens,
    token: CancellationToken,
    next: ResolveCodeLensSignature,
  ) => ProviderResult<VCodeLens>;
}

export type CodeLensProviderShape = {
  provider?: CodeLensProvider;
  onDidChangeCodeLensEmitter: EventEmitter<void>;
};

export class CodeLensFeature extends TextDocumentLanguageFeature<
  CodeLensOptions,
  CodeLensRegistrationOptions,
  CodeLensProviderShape,
  CodeLensMiddleware
> {
  constructor(client: FeatureClient<CodeLensMiddleware>) {
    super(client, CodeLensRequest.type);
  }

  public fillClientCapabilities(capabilities: ClientCapabilities): void {
    ensure(ensure(capabilities, 'textDocument')!, 'codeLens')!.dynamicRegistration =
      true;
    ensure(ensure(capabilities, 'workspace')!, 'codeLens')!.refreshSupport = true;
  }

  public initialize(
    capabilities: ServerCapabilities,
    documentSelector: DocumentSelector,
  ): void {
    const client = this._client;
    client.onRequest(CodeLensRefreshRequest.type, async () => {
      for (const provider of this.getAllProviders()) {
        provider.onDidChangeCodeLensEmitter.fire();
      }
    });
    const options = this.getRegistrationOptions(
      documentSelector,
      capabilities.codeLensProvider,
    );
    if (!options) {
      return;
    }
    this.register({ id: UUID.generateUuid(), registerOptions: options });
  }

  protected registerLanguageProvider(
    options: CodeLensRegistrationOptions,
  ): [Disposable, CodeLensProviderShape] {
    const selector = options.documentSelector!;
    const eventEmitter: EventEmitter<void> = new EventEmitter<void>();
    const provider: CodeLensProvider = {
      onDidChangeCodeLenses: eventEmitter.event,
      provideCodeLenses: (document, token) => {
        const client = this._client;
        const provideCodeLenses: ProvideCodeLensesSignature = (document, token) => {
          return client
            .sendRequest(
              CodeLensRequest.type,
              client.code2ProtocolConverter.asCodeLensParams(document),
              token,
            )
            .then(
              (result) => {
                if (token.isCancellationRequested) {
                  return null;
                }
                return client.protocol2CodeConverter.asCodeLenses(result, token);
              },
              (error) => {
                return client.handleFailedRequest(
                  CodeLensRequest.type,
                  token,
                  error,
                  null,
                );
              },
            );
        };
        const middleware = client.middleware;
        return middleware.provideCodeLenses
          ? middleware.provideCodeLenses(document, token, provideCodeLenses)
          : provideCodeLenses(document, token);
      },
      resolveCodeLens: options.resolveProvider
        ? (
            codeLens: VCodeLens,
            token: CancellationToken,
          ): ProviderResult<VCodeLens> => {
            const client = this._client;
            const resolveCodeLens: ResolveCodeLensSignature = (codeLens, token) => {
              return client
                .sendRequest(
                  CodeLensResolveRequest.type,
                  client.code2ProtocolConverter.asCodeLens(codeLens),
                  token,
                )
                .then(
                  (result) => {
                    if (token.isCancellationRequested) {
                      return codeLens;
                    }
                    return client.protocol2CodeConverter.asCodeLens(result);
                  },
                  (error) => {
                    return client.handleFailedRequest(
                      CodeLensResolveRequest.type,
                      token,
                      error,
                      codeLens,
                    );
                  },
                );
            };
            const middleware = client.middleware;
            return middleware.resolveCodeLens
              ? middleware.resolveCodeLens(codeLens, token, resolveCodeLens)
              : resolveCodeLens(codeLens, token);
          }
        : undefined,
    };
    return [
      Languages.registerCodeLensProvider(
        this._client.protocol2CodeConverter.asDocumentSelector(selector),
        provider,
      ),
      { provider, onDidChangeCodeLensEmitter: eventEmitter },
    ];
  }
}
