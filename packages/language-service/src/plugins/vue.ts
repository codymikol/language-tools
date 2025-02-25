import type { ServicePlugin, ServicePluginInstance } from '@volar/language-service';
import * as vue from '@vue/language-core';
import { create as createHtmlService } from 'volar-service-html';
import type { Provide as TSProvide } from 'volar-service-typescript';
import * as html from 'vscode-html-languageservice';
import type * as vscode from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { loadLanguageBlocks } from './data';

let sfcDataProvider: html.IHTMLDataProvider | undefined;

export interface Provide {
	'vue/vueFile': (document: TextDocument) => vue.VueFile | undefined;
}

export function create(): ServicePlugin {
	return {
		name: 'vue-basic',
		create(context): ServicePluginInstance<Provide> {

			const htmlPlugin = createHtmlService({ languageId: 'vue', useCustomDataProviders: false }).create(context);

			if (!context)
				return htmlPlugin as any;

			sfcDataProvider ??= html.newHTMLDataProvider('vue', loadLanguageBlocks(context.env.locale ?? 'en'));

			htmlPlugin.provide['html/languageService']().setDataProviders(false, [sfcDataProvider]);

			return {

				...htmlPlugin,

				provide: {
					'vue/vueFile': document => {
						return worker(document, (vueFile) => {
							return vueFile;
						});
					},
				},

				provideSemanticDiagnostics(document) {
					return worker(document, (vueSourceFile) => {

						if (!vueSourceFile.mainTsFile) {
							return;
						}

						const result: vscode.Diagnostic[] = [];
						const sfc = vueSourceFile.sfc;
						const program = context.inject<TSProvide, 'typescript/languageService'>('typescript/languageService').getProgram();
						const tsFileName = vueSourceFile.mainTsFile.fileName;

						if (program && !program.getSourceFile(tsFileName)) {
							for (const script of [sfc.script, sfc.scriptSetup]) {

								if (!script || script.content === '')
									continue;

								const error: vscode.Diagnostic = {
									range: {
										start: document.positionAt(script.start),
										end: document.positionAt(script.startTagEnd),
									},
									message: `Virtual script ${JSON.stringify(tsFileName)} not found, may missing <script lang="ts"> / "allowJs": true / jsconfig.json.`,
									severity: 3 satisfies typeof vscode.DiagnosticSeverity.Information,
									source: 'vue',
								};
								result.push(error);
							}
						}

						return result;
					});
				},

				provideDocumentLinks: undefined,

				provideDocumentSymbols(document) {
					return worker(document, (vueSourceFile) => {

						const result: vscode.DocumentSymbol[] = [];
						const descriptor = vueSourceFile.sfc;

						if (descriptor.template) {
							result.push({
								name: 'template',
								kind: 2 satisfies typeof vscode.SymbolKind.Module,
								range: {
									start: document.positionAt(descriptor.template.start),
									end: document.positionAt(descriptor.template.end),
								},
								selectionRange: {
									start: document.positionAt(descriptor.template.start),
									end: document.positionAt(descriptor.template.startTagEnd),
								},
							});
						}
						if (descriptor.script) {
							result.push({
								name: 'script',
								kind: 2 satisfies typeof vscode.SymbolKind.Module,
								range: {
									start: document.positionAt(descriptor.script.start),
									end: document.positionAt(descriptor.script.end),
								},
								selectionRange: {
									start: document.positionAt(descriptor.script.start),
									end: document.positionAt(descriptor.script.startTagEnd),
								},
							});
						}
						if (descriptor.scriptSetup) {
							result.push({
								name: 'script setup',
								kind: 2 satisfies typeof vscode.SymbolKind.Module,
								range: {
									start: document.positionAt(descriptor.scriptSetup.start),
									end: document.positionAt(descriptor.scriptSetup.end),
								},
								selectionRange: {
									start: document.positionAt(descriptor.scriptSetup.start),
									end: document.positionAt(descriptor.scriptSetup.startTagEnd),
								},
							});
						}
						for (const style of descriptor.styles) {
							let name = 'style';
							if (style.scoped)
								name += ' scoped';
							if (style.module)
								name += ' module';
							result.push({
								name,
								kind: 2 satisfies typeof vscode.SymbolKind.Module,
								range: {
									start: document.positionAt(style.start),
									end: document.positionAt(style.end),
								},
								selectionRange: {
									start: document.positionAt(style.start),
									end: document.positionAt(style.startTagEnd),
								},
							});
						}
						for (const customBlock of descriptor.customBlocks) {
							result.push({
								name: `${customBlock.type}`,
								kind: 2 satisfies typeof vscode.SymbolKind.Module,
								range: {
									start: document.positionAt(customBlock.start),
									end: document.positionAt(customBlock.end),
								},
								selectionRange: {
									start: document.positionAt(customBlock.start),
									end: document.positionAt(customBlock.startTagEnd),
								},
							});
						}

						return result;
					});
				},

				provideDocumentFormattingEdits(document) {
					return worker(document, (vueSourceFile) => {

						const blocks = [
							vueSourceFile.sfc.script,
							vueSourceFile.sfc.scriptSetup,
							vueSourceFile.sfc.template,
							...vueSourceFile.sfc.styles,
							...vueSourceFile.sfc.customBlocks,
						].filter((block): block is NonNullable<typeof block> => !!block)
							.sort((a, b) => b.start - a.start);

						const edits: vscode.TextEdit[] = [];

						for (const block of blocks) {
							const startPos = document.positionAt(block.start);
							if (startPos.character !== 0) {
								edits.push({
									range: {
										start: {
											line: startPos.line,
											character: 0,
										},
										end: startPos,
									},
									newText: '',
								});
							}
						}

						return edits;
					});
				},
			};

			function worker<T>(document: TextDocument, callback: (vueSourceFile: vue.VueFile) => T) {
				const [vueFile] = context.language.files.getVirtualFile(context.env.uriToFileName(document.uri));
				if (vueFile instanceof vue.VueFile) {
					return callback(vueFile);
				}
			}
		},
	};
}
