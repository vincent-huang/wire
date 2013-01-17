/** @license MIT License (c) copyright B Cavalier & J Hann */

/**
 * Base wire plugin that provides properties, init, and destroy facets, and
 * a proxy for plain JS objects.
 *
 * wire is part of the cujo.js family of libraries (http://cujojs.com/)
 *
 * Licensed under the MIT License at:
 * http://www.opensource.org/licenses/mit-license.php
 */

(function(define) { 'use strict';
define(function(require) {

	var when, object, functional, createComponent, createInvoker,
		whenAll, chain, obj, undef;

	when = require('when');
	object = require('../object');
	functional = require('../functional');
	createComponent = require('../component');
	createInvoker = require('../invoker');

	whenAll = when.all;
	chain = when.chain;

	obj = {};

	function asArray(it) {
		return Array.isArray(it) ? it : [it];
	}

	function invoke(func, proxy, args, wire) {
        return when(wire(args, func, proxy.path),
			function (resolvedArgs) {
				return proxy.invoke(func, asArray(resolvedArgs));
			}
		);
	}

	function invokeAll(facet, wire) {
		var options = facet.options;

		if(typeof options == 'string') {
			return invoke(options, facet, [], wire);

		} else {
			var promises, funcName;
			promises = [];

			for(funcName in options) {
				promises.push(invoke(funcName, facet, options[funcName], wire));
			}

			return whenAll(promises);
		}
	}

	//
	// Mixins
	//

	function mixin(target, src) {
		var name, s;

		for(name in src) {
			s = src[name];
			if(!(name in target) || (target[name] !== s && (!(name in obj) || obj[name] !== s))) {
				target[name] = s;
			}
		}

		return target;
	}

	function doMixin(target, introduction, wire) {
		introduction = typeof introduction == 'string'
			? wire.resolveRef(introduction)
			: wire(introduction);

		return when(introduction, mixin.bind(null, target));
	}

	function mixinFacet(resolver, facet, wire) {
		var target, intros;

		target = facet.target;
		intros = facet.options;

		if(!Array.isArray(intros)) {
			intros = [intros];
		}

		chain(when.reduce(intros, function(target, intro) {
			return doMixin(target, intro, wire);
		}, target), resolver);
	}

    /**
     * Factory that handles cases where you need to create an object literal
     * that has a property whose name would trigger another wire factory.
     * For example, if you need an object literal with a property named "create",
     * which would normally cause wire to try to construct an instance using
     * a constructor or other function, and will probably result in an error,
     * or an unexpected result:
     * myObject: {
     *      create: "foo"
     *    ...
     * }
     *
     * You can use the literal factory to force creation of an object literal:
     * myObject: {
     *    literal: {
     *      create: "foo"
     *    }
     * }
     *
     * which will result in myObject.create == "foo" rather than attempting
     * to create an instance of an AMD module whose id is "foo".
     */
	function literalFactory(resolver, spec /*, wire */) {
		resolver.resolve(spec.literal);
	}

	/**
	 * @deprecated Use create (instanceFactory) instead
	 * @param resolver
	 * @param spec
	 * @param wire
	 */
	function protoFactory(resolver, spec, wire) {
		var parentRef, promise;

        parentRef = spec.prototype;

        promise = typeof parentRef === 'string'
                ? wire.resolveRef(parentRef)
                : wire(parentRef);

        when(promise, Object.create)
			.then(resolver.resolve, resolver.reject);
	}

	function propertiesFacet(resolver, facet, wire) {

		var properties, path, setProperty;

		properties = facet.options;
		path = facet.path;
		setProperty = facet.set.bind(facet);

		when.map(Object.keys(facet.options), function(key) {
			return wire(properties[key], key, facet.path)
				.then(function(wiredProperty) {
					setProperty(key, wiredProperty);
				}
			);
		}).then(resolver.resolve, resolver.reject);

	}

	function invokerFactory(resolver, componentDef, wire) {

		wire(componentDef.invoker).then(function(invokerContext) {
			// It'd be nice to use wire.getProxy() then proxy.invoke()
			// here, but that means the invoker must always return
			// a promise.  Not sure that's best, so for now, just
			// call the method directly
			return createInvoker(invokerContext.method, invokerContext.args);
		}).then(resolver.resolve, resolver.reject);

	}

	function invokerFacet(resolver, facet, wire) {
		chain(invokeAll(facet, wire), resolver);
	}

    //noinspection JSUnusedLocalSymbols
    /**
     * Wrapper for use with when.reduce that calls the supplied destroyFunc
     * @param [unused]
     * @param destroyFunc {Function} destroy function to call
     */
    function destroyReducer(unused, destroyFunc) {
        return destroyFunc();
    }

	function moduleFactory(resolver, spec, wire) {
		chain(wire.loadModule(spec.module, spec), resolver);
	}

	function cloneFactory(resolver, spec, wire) {
		var sourceRef, options;

		if (wire.resolver.isRef(spec.clone.source)) {
			sourceRef = spec.clone.source;
			options = spec.clone;
		}
		else {
			sourceRef = spec.clone;
			options = {};
		}

		when(wire(sourceRef), function (ref) {
			return when(wire.getProxy(ref), function (proxy) {
				if (!proxy.clone) {
					throw new Error('No clone function found for ' + spec.id);
				}

				return proxy.clone(options);
			});
		}).then(resolver.resolve, resolver.reject);
	}

	/**
	 * Factory that uses an AMD module either directly, or as a
	 * constructor or plain function to create the resulting item.
	 *
	 * @param {Object} resolver resolver to resolve with the created component
	 * @param {Object} spec portion of the spec for the component to be created
	 * @param {function} wire
	 */
	function instanceFactory(resolver, spec, wire) {
		var create, args, isConstructor, name, module, instance;

		name = spec.id;
		create = spec.create;

		if (typeof create == 'string') {
			module = wire({ module: create });
		} else if(wire.resolver.isRef(create)) {
			module = wire(create);
		} else if(object.isObject(create) && create.module) {
			module = wire({ module: create.module });
			args = create.args ? wire(asArray(create.args)) : [];
			isConstructor = create.isConstructor;
		} else {
			module = create;
		}

		instance = when.join(module, args).spread(createInstance);
		chain(instance, resolver);

		// Load the module, and use it to create the object
		function createInstance(module, args) {
			// We'll either use the module directly, or we need
			// to instantiate/invoke it.
			return typeof module == 'function'
				? createComponent(module, args, isConstructor)
				: Object.create(module);
		}
	}

	function composeFactory(resolver, spec, wire) {
		var promise;

		spec = spec.compose;

		if(typeof spec == 'string') {
			promise = functional.compose.parse(undef, spec, wire);
		} else {
			// Assume it's an array of things that will wire to functions
			promise = when(wire(spec), function(funcArray) {
				return functional.compose(funcArray);
			});
		}

		when.chain(promise, resolver);
	}

	return {
		wire$plugin: function(ready, destroyed /*, options */) {
            // Components in the current context that will be destroyed
            // when this context is destroyed
			var destroyFuncs, plugin;

			destroyFuncs = [];

			when(destroyed, function() {
                return when.reduce(destroyFuncs, destroyReducer, 0);
			});

			function destroyFacet(resolver, facet, wire) {
				destroyFuncs.push(function destroyObject() {
					return invokeAll(facet, wire);
				});

				// This resolver is just related to *collecting* the functions to
				// invoke when the component is destroyed.
				resolver.resolve();
			}

			plugin = {
				factories: {
					module: moduleFactory,
					create: instanceFactory,
					literal: literalFactory,
					prototype: protoFactory,
					clone: cloneFactory,
					compose: composeFactory,
					invoker: invokerFactory
				},
				facets: {
					// properties facet.  Sets properties on components
					// after creation.
					properties: {
						configure: propertiesFacet
					},
					mixin: {
						configure: mixinFacet
					},
					// init facet.  Invokes methods on components during
					// the "init" stage.
					init: {
						initialize: invokerFacet
					},
					// ready facet.  Invokes methods on components during
					// the "ready" stage.
					ready: {
						ready: invokerFacet
					},
					// destroy facet.  Registers methods to be invoked
					// on components when the enclosing context is destroyed
					destroy: {
						ready: destroyFacet
					}
				}
			};

			// "introduce" is deprecated, but preserved here for now.
			plugin.facets.introduce = plugin.facets.mixin;

			return plugin;
		}
	};
});
})(typeof define == 'function'
	? define
	: function(factory) { module.exports = factory(require); }
);