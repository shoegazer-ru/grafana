import {
  AppPlugin,
  DataSourceApi,
  DataSourceJsonData,
  DataSourcePlugin,
  DataSourcePluginMeta,
  PluginMeta,
} from '@grafana/data';
import { DataQuery } from '@grafana/schema';

import { GenericDataSourcePlugin } from '../datasources/types';

import builtInPlugins from './built_in_plugins';
import { getPluginFromCache, registerPluginInCache } from './loader/cache';
// SystemJS has to be imported before the sharedDependenciesMap
import { SystemJS } from './loader/systemjs';
// eslint-disable-next-line import/order
import { sharedDependenciesMap } from './loader/sharedDependencies';
import { decorateSystemJSFetch, decorateSystemJSResolve, decorateSystemJsOnload } from './loader/systemjsHooks';
import { SystemJSWithLoaderHooks } from './loader/types';
import { buildImportMap, isHostedOnCDN, resolveModulePath } from './loader/utils';
import { importPluginModuleInSandbox } from './sandbox/sandbox_plugin_loader';
import { isFrontendSandboxSupported } from './sandbox/utils';

const imports = buildImportMap(sharedDependenciesMap);

SystemJS.addImportMap({ imports });

const systemJSPrototype: SystemJSWithLoaderHooks = SystemJS.constructor.prototype;

// This instructs SystemJS to load a plugin using fetch and eval if it returns a truthy value, otherwise it will load the plugin using a script tag.
// We only want to fetch and eval plugins that are hosted on a CDN or are Angular plugins.
systemJSPrototype.shouldFetch = function (url) {
  const pluginInfo = getPluginFromCache(url);

  return isHostedOnCDN(url) || Boolean(pluginInfo?.isAngular);
};

const originalImport = systemJSPrototype.import;
// Hook Systemjs import to support plugins that only have a default export.
systemJSPrototype.import = function (...args: Parameters<typeof originalImport>) {
  return originalImport.apply(this, args).then((module) => {
    if (module && module.__useDefault) {
      return module.default;
    }
    return module;
  });
};

const systemJSFetch = systemJSPrototype.fetch;
systemJSPrototype.fetch = function (url: string, options?: Record<string, unknown>) {
  return decorateSystemJSFetch(systemJSFetch, url, options);
};

const systemJSResolve = systemJSPrototype.resolve;
systemJSPrototype.resolve = decorateSystemJSResolve.bind(systemJSPrototype, systemJSResolve);

// Older plugins load .css files which resolves to a CSS Module.
// https://github.com/WICG/webcomponents/blob/gh-pages/proposals/css-modules-v1-explainer.md#importing-a-css-module
// Any css files loaded via SystemJS have their styles applied onload.
systemJSPrototype.onload = decorateSystemJsOnload;

export async function importPluginModule({
  path,
  version,
  isAngular,
  pluginId,
}: {
  path: string;
  pluginId: string;
  version?: string;
  isAngular?: boolean;
}): Promise<System.Module> {
  if (version) {
    registerPluginInCache({ path, version, isAngular });
  }

  const builtIn = builtInPlugins[path];
  if (builtIn) {
    // for handling dynamic imports
    if (typeof builtIn === 'function') {
      return await builtIn();
    } else {
      return builtIn;
    }
  }

  let modulePath = resolveModulePath(path);

  // the sandboxing environment code cannot work in nodejs and requires a real browser
  if (await isFrontendSandboxSupported({ isAngular, pluginId })) {
    return importPluginModuleInSandbox({ pluginId });
  }

  return SystemJS.import(modulePath);
}

export function importDataSourcePlugin(meta: DataSourcePluginMeta): Promise<GenericDataSourcePlugin> {
  return importPluginModule({
    path: meta.module,
    version: meta.info?.version,
    isAngular: meta.angular?.detected,
    pluginId: meta.id,
  }).then((pluginExports) => {
    if (pluginExports.plugin) {
      const dsPlugin: GenericDataSourcePlugin = pluginExports.plugin;
      dsPlugin.meta = meta;
      return dsPlugin;
    }

    if (pluginExports.Datasource) {
      const dsPlugin = new DataSourcePlugin<
        DataSourceApi<DataQuery, DataSourceJsonData>,
        DataQuery,
        DataSourceJsonData
      >(pluginExports.Datasource);
      dsPlugin.setComponentsFromLegacyExports(pluginExports);
      dsPlugin.meta = meta;
      return dsPlugin;
    }

    throw new Error('Plugin module is missing DataSourcePlugin or Datasource constructor export');
  });
}

export function importAppPlugin(meta: PluginMeta): Promise<AppPlugin> {
  return importPluginModule({
    path: meta.module,
    version: meta.info?.version,
    isAngular: meta.angular?.detected,
    pluginId: meta.id,
  }).then((pluginExports) => {
    const plugin: AppPlugin = pluginExports.plugin ? pluginExports.plugin : new AppPlugin();
    plugin.init(meta);
    plugin.meta = meta;
    plugin.setComponentsFromLegacyExports(pluginExports);
    return plugin;
  });
}
