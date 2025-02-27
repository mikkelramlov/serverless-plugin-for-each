'use strict';

const Ajv = require('ajv');
const get = require('lodash.get');
const set = require('lodash.set');

const EXCLUDE_PATHS = new Set([
	'serverless', 'serviceObject', 'pluginsData', 'package',
	'configValidationMode', 'disabledDeprecations', 'serviceFilename', 'app',
	'tenant', 'org', 'initialServerlessConfig'
]);

const SCHEMA = {
	type: 'object',
	properties: {
		iterator: {
			oneOf: [
				{
					type: ['array']
				},
				{
					type: 'object',
					oneOf: [
						{
							properties: {
								$env: {
									type: 'string'
								}
							},
							required: ['$env'],
							additionalProperties: false
						},
						{
							not: {
								required: ['$env']
							},
							additionalProperties: true,
						}
					]
				}
			]
		},
		template: {
			oneOf: [
				{ type: 'array' },
				{ type: 'object' },
			]
		}
	},
	required: ['iterator', 'template'],
	additionalProperties: false
};

class ForEachPlugin {
	constructor(serverless, cliOptions, { log } = {}) {
		this.serverless = serverless;
		this.log = log;

		this.ajv = new Ajv({ allowUnionTypes: true });
		this.validator = this.ajv.compile(SCHEMA);

		this.hooks = {
			'after:package:initialize': this.replace.bind(this),
		};

		if (this.serverless.configSchemaHandler && this.serverless.configSchemaHandler.defineFunctionEvent) {
			this.serverless.configSchemaHandler.defineFunctionEvent('aws', '$forEach', SCHEMA);
		}
	}

	interpolate(template, key, value) {
		const stringified = JSON.stringify(template);

		const interpolated = stringified
			.replace(/\$forEach.key/g, key)
			.replace(/\$forEach.value/g, value);

		try {
			return JSON.parse(interpolated);
		} catch (error) {
			throw new Error(`Interpolated template is not a valid JSON: ${interpolated}`);
		}
	}

	findAndReplace(obj, path) {
		let count = 0;

		if (Array.isArray(obj)) {
			// iterate in the reverse order so that templates that increase
			// array size does not mess up ordering
			for (let i = obj.length - 1; i >= 0; i--) {
				count += this.findAndReplace(obj[i], [...path, i]);
			}
		} else if (typeof obj === 'object' && obj !== null) {
			for (const key in obj) {
				count += this.findAndReplace(obj[key], [...path, key]);

				if (key === '$forEach') {
					count++;

					this.validate(obj[key], `${path}/${key}`);

					const { iterator: rawIterator, template } = obj[key];

					const iterator = {};
					if (rawIterator.$env) {
						Object.entries(process.env).forEach(([name, value]) => {
							if (name.match(rawIterator.$env)) {
								iterator[name] = value;
							}
						});
					} else if (Array.isArray(rawIterator)) {
						rawIterator.forEach((value, idx) => iterator[idx] = value);
					} else {
						Object.assign(iterator, rawIterator);
					}

					const interpolated = Object.entries(iterator).reduce((acc, [key, value]) => {
						const entry = this.interpolate(template, key, value);

						return Array.isArray(template)
							? acc.concat(entry)
							: { ...acc, ...entry };
					}, Array.isArray(template) ? [] : {});

					if (Number.isInteger(path[path.length-1]) && Array.isArray(interpolated)) {
						const index = path.pop()

						get(this.serverless.service, path).splice(index, 1, ...interpolated);
					} else {
						const { $forEach, ...result } = obj; // eslint-disable-line no-unused-vars

						if (Array.isArray(interpolated) && Object.keys(result).length > 0) {
							throw new Error('Can\'t merge array into object');
						}

						set(this.serverless.service, path, { ...result, ...interpolated });
					}
				}
			}
		}

		return count;
	}

	validate(config, path) {
		if (!this.validator(config)) {
			throw new Error(this.ajv.errorsText(this.validator.errors, { dataVar: path }));
		}
	}

	replace() {
		if (this.log && this.log.info) {
			this.log.info('Scanning configuration to replace $forEach');
		}

		const count = Object.entries(this.serverless.service).reduce((acc, [path, value]) => {
			if (!EXCLUDE_PATHS.has(path)) {
				acc += this.findAndReplace(value, [path]);
			}

			return acc;
		}, 0);

		if (this.log && this.log.success) {
			this.log.success(`Found and replaced ${count} $forEach matches`);
		}

		return count;
	}
}

module.exports = ForEachPlugin;
