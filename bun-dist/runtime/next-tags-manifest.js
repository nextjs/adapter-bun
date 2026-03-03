var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
const NEXT_TAG_MANIFEST_MODULE_SPECIFIERS = [
    'next/dist/esm/server/lib/incremental-cache/tags-manifest.external.js',
    'next/dist/server/lib/incremental-cache/tags-manifest.external.js',
];
let nextTagManifestMapsPromise = null;
async function loadNextTagManifestMaps() {
    if (!nextTagManifestMapsPromise) {
        nextTagManifestMapsPromise = (async () => {
            const manifests = [];
            for (const specifier of NEXT_TAG_MANIFEST_MODULE_SPECIFIERS) {
                try {
                    const mod = (await import(__rewriteRelativeImportExtension(specifier)));
                    const tagsManifest = mod.tagsManifest;
                    if (tagsManifest instanceof Map && !manifests.includes(tagsManifest)) {
                        manifests.push(tagsManifest);
                    }
                }
                catch {
                    // Optional module variant may be unavailable in this runtime.
                }
            }
            return manifests;
        })();
    }
    return nextTagManifestMapsPromise;
}
export async function syncNextTagManifest(tags, update) {
    if (tags.length === 0)
        return;
    const manifests = await loadNextTagManifestMaps();
    if (manifests.length === 0)
        return;
    for (const manifest of manifests) {
        for (const tag of tags) {
            const existing = manifest.get(tag) ?? {};
            if (update.mode === 'stale') {
                const nextEntry = {
                    ...existing,
                    stale: update.now,
                };
                if (typeof update.expireSeconds === 'number' &&
                    Number.isFinite(update.expireSeconds)) {
                    nextEntry.expired = update.now + update.expireSeconds * 1000;
                }
                manifest.set(tag, nextEntry);
            }
            else {
                manifest.set(tag, {
                    ...existing,
                    expired: update.now,
                });
            }
        }
    }
}
