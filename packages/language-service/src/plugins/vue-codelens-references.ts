import { ServicePlugin, ServicePluginInstance } from '@volar/language-service';
import { SourceFile, VirtualFile, VueCodeInformation, VueFile } from '@vue/language-core';
import type * as vscode from 'vscode-languageserver-protocol';

export function create(): ServicePlugin {
	return {
		name: 'vue-codelens-references',
		create(context): ServicePluginInstance {
			return {
				provideReferencesCodeLensRanges(document) {

					return worker(document.uri, async virtualFile => {

						const result: vscode.Range[] = [];

						for (const map of context.documents.getMaps(virtualFile) ?? []) {
							for (const mapping of map.map.mappings) {

								if (!(mapping.data as VueCodeInformation).__referencesCodeLens)
									continue;

								result.push({
									start: document.positionAt(mapping.generatedOffsets[0]),
									end: document.positionAt(
										mapping.generatedOffsets[mapping.generatedOffsets.length - 1]
										+ mapping.lengths[mapping.lengths.length - 1]
									),
								});
							}
						}

						return result;
					});
				},
			};

			function worker<T>(uri: string, callback: (vueFile: VirtualFile, sourceFile: SourceFile) => T) {

				const [virtualFile, sourceFile] = context.language.files.getVirtualFile(context.env.uriToFileName(uri));
				if (!(sourceFile?.virtualFile?.[0] instanceof VueFile) || !sourceFile)
					return;

				return callback(virtualFile, sourceFile);
			}
		},
	};
}
