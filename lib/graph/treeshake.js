"use strict";

var babel = require("babel-standalone");
var dependencyResolver = require("../node/dependency_resolver");
var processBabelPlugins = require("../process_babel_plugins");
var processBabelPresets = require("../process_babel_presets");
var rollup = require("steal-rollup");
var source = require("../node/source");
var transformActiveSource = require("../node/transform_active_source");

var moduleNameFromSpecifier = dependencyResolver.moduleNameFromSpecifier;
var moduleSpecifierFromName = dependencyResolver.moduleSpecifierFromName;

function treeshake(data) {
	let getNode = id => data.graph[id];

	return rollup.rollup({
		entry: data.mains[0],
		acorn: {
			allowReserved: true,
			ecmaVersion: 9
		},
		experimentalPreserveModules: true,
		plugins: [
			loadFromGraph(getNode),
			transpile(getNode, data)
		],
		onwarn: function(){}
	}).then(function(bundle){
		return bundle.generate({
			format:'es'
		}).then(function(chunks){
			for(let chunkName in chunks) {
				let chunk = chunks[chunkName];

				let id = getModuleNameFromChunk(chunk);
				let node = getNode(id);
				if(notESModule(node)) {
					continue;
				}

				var newDependencies = [];
				var newDeps = [];
				for(var i = 0; i < chunk.imports.length; i++) {
					let depChunkName = chunk.imports[i];
					let depChunk = chunks[depChunkName];
					let depName = getModuleNameFromChunk(depChunk);
					newDependencies.push(depName);

					let specifier = moduleSpecifierFromName(node, depName);
					newDeps.push(specifier || depName);
				}

				if(newDependencies.length) {
					node.dependencies = node.load.metadata.dependencies = newDependencies;
					node.deps = node.load.metadata.deps = newDeps;
				}

				transformActiveSource(node, "treeshake", function(){
					return {
						code: chunk.code
					};
				});
			}
		});

	});
}

function loadFromGraph(getNode) {
	return {
		resolveId: function(id, importer) {
			if(importer) {
				let node = getNode(importer);
				return moduleNameFromSpecifier(node, id);
			}
			return id;
		},
		load: function(id) {
			let node = getNode(id);

			if(notESModule(node)) {
				let needToExport = new Set();
				let dependants = (node && node.load.metadata.dependants) || [];

				// Determine what to export by looking at dependants imports
				for(let depName of dependants) {
					let localNode = getNode(depName);
					let subgraph = localNode.load.metadata.subgraph;
					if(!subgraph) {
						continue;
					}

					for(let imp of subgraph.imports) {
						let depName = moduleNameFromSpecifier(localNode, imp.source);
						if(depName !== id) {
							continue;
						}

						for(let spec of imp.specifiers) {
							needToExport.add(spec.imported);
						}
					}
				}

				// Expose named exports so that dependant modules will tree-shake properly.
				if(needToExport.size) {
					let code = '';
					for(let exp of needToExport) {
						if(exp === "default") {
							code += "export default {};\n";
						} else {
							code += `export let ${exp} = {};\n`;
						}
					}

					return code;
				} else {
					return "export default {}";
				}
			}

			return source.node(node);
		}
	};
}

function transpile(getNode, data) {
	let loader = data.loader;
	let opts = loader.babelOptions || {};
	let required = ["es2015", {loose: false, modules: false}];

	opts.presets = processBabelPresets({
		baseURL: loader.baseURL,
		babelOptions: opts,
		loaderEnv: loader.getEnv()
	});

	opts.plugins = processBabelPlugins({
		baseURL: loader.baseURL,
		babelOptions: opts,
		loaderEnv: loader.getEnv()
	});

	if(opts.presets && opts.presets.length) {
		opts.presets = [required].concat(opts.presets);
	} else {
		opts.presets = [
			"react",
			"stage-0",
			required
		];
	}

	opts.sourceMaps = true;

	return {
		transform: function(code, id) {
			let node = getNode(id);
			if(notESModule(node)) {
				return code;
			}

			let result = babel.transform(code, opts);

			for(let depName of node.load.metadata.dependencies) {
				let localNode = getNode(depName);
				if(!localNode) {
					continue;
				}
				if(!localNode.load.metadata.dependants) {
					localNode.load.metadata.dependants = [];
				}
				localNode.load.metadata.dependants.push(id);
			}

			// Update metadata with specifiers
			node.load.metadata.subgraph = result.metadata.modules;

			return {
				code: result.code,
				map: result.map
			};
		}
	};
}

function notESModule(node) {
	return !node || node.load.metadata.format !== "es6";
}

function getModuleNameFromChunk(chunk) {
	return chunk.modules[0];
}

module.exports = treeshake;