/* eslint-disable no-console */
/* eslint-disable no-restricted-syntax */

import { Disposable } from '@difizen/libro-common/app';
import { singleton } from '@difizen/libro-common/app';
import type { IGrammarConfiguration } from 'vscode-textmate';

import type { TokenizerOption } from './textmate-tokenizer.js';

export interface TextmateGrammarConfiguration extends IGrammarConfiguration {
  /**
   * Optional options to further refine the tokenization of the grammar.
   */
  readonly tokenizerOption?: TokenizerOption;
}

export interface GrammarDefinitionProvider {
  getGrammarDefinition: () => Promise<GrammarDefinition>;
  getInjections?: (scopeName: string) => string[];
}

export interface GrammarDefinition {
  format: 'json' | 'plist';
  content: Record<string, unknown> | string;
  location?: string;
}

@singleton()
export class TextmateRegistry {
  protected readonly scopeToProvider = new Map<string, GrammarDefinitionProvider[]>();
  protected readonly languageToConfig = new Map<
    string,
    TextmateGrammarConfiguration[]
  >();
  protected readonly languageIdToScope = new Map<string, string[]>();

  get languages(): IterableIterator<string> {
    return this.languageIdToScope.keys();
  }

  registerTextmateGrammarScope(
    scope: string,
    provider: GrammarDefinitionProvider,
  ): Disposable {
    const providers = this.scopeToProvider.get(scope) || [];
    const existingProvider = providers[0];
    if (existingProvider) {
      Promise.all([
        existingProvider.getGrammarDefinition(),
        provider.getGrammarDefinition(),
      ])
        .then(([a, b]) => {
          if (a.location !== b.location || (!a.location && !b.location)) {
            console.warn(
              `a registered grammar provider for '${scope}' scope is overridden`,
            );
          }
          return;
        })
        .catch(console.error);
    }
    providers.unshift(provider);
    this.scopeToProvider.set(scope, providers);
    return Disposable.create(() => {
      const index = providers.indexOf(provider);
      if (index !== -1) {
        providers.splice(index, 1);
      }
    });
  }

  getProvider(scope: string): GrammarDefinitionProvider | undefined {
    const providers = this.scopeToProvider.get(scope);
    return providers && providers[0];
  }

  mapLanguageIdToTextmateGrammar(languageId: string, scope: string): Disposable {
    const scopes = this.languageIdToScope.get(languageId) || [];
    const existingScope = scopes[0];
    if (typeof existingScope === 'string') {
      console.warn(
        `'${languageId}' language is remapped from '${existingScope}' to '${scope}' scope`,
      );
    }
    scopes.unshift(scope);
    this.languageIdToScope.set(languageId, scopes);
    return Disposable.create(() => {
      const index = scopes.indexOf(scope);
      if (index !== -1) {
        scopes.splice(index, 1);
      }
    });
  }

  getScope(languageId: string): string | undefined {
    const scopes = this.languageIdToScope.get(languageId);
    return scopes && scopes[0];
  }

  getLanguageId(scope: string): string | undefined {
    for (const languageId of this.languageIdToScope.keys()) {
      if (this.getScope(languageId) === scope) {
        return languageId;
      }
    }
    return undefined;
  }

  registerGrammarConfiguration(
    languageId: string,
    config: TextmateGrammarConfiguration,
  ): Disposable {
    const configs = this.languageToConfig.get(languageId) || [];
    const existingConfig = configs[0];
    if (existingConfig) {
      console.warn(
        `a registered grammar configuration for '${languageId}' language is overridden`,
      );
    }
    configs.unshift(config);
    this.languageToConfig.set(languageId, configs);
    return Disposable.create(() => {
      const index = configs.indexOf(config);
      if (index !== -1) {
        configs.splice(index, 1);
      }
    });
  }

  getGrammarConfiguration(languageId: string): TextmateGrammarConfiguration {
    const configs = this.languageToConfig.get(languageId);
    return (configs && configs[0]) || {};
  }
}
