/** Browser-safe intake contract. File contents are screened separately on the server. */
export const sourceTextExtensions = ['html','htm','css','scss','sass','less','js','jsx','ts','tsx','mjs','cjs','mts','cts','mjsx','cjsx','mtsx','ctsx','json','yaml','yml','md','txt','log','sql','prisma','php','py','rb','go','rs','java','cs','csproj','cshtml','razor','vue','svelte','astro','liquid','twig','hbs','ejs','tpl','toml','xml','graphql','gql','proto','tf','hcl','conf','config','ini','service','properties'] as const;
export const sourceTextBasenames = ['Dockerfile','Containerfile','Caddyfile','Jenkinsfile','Makefile','Gemfile','.htaccess'] as const;

export function isSupportedReviewPath(path: string): boolean {
  if (!path || path.length > 180 || !/^[A-Za-z0-9_@./-]+$/.test(path)) return false;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /^\.?(?:env(?:\.|$)|git$|ssh$|npmrc$|netrc$|credentials?(?:\.|$)|secrets?(?:\.|$))/i.test(part))) return false;
  const basename = parts.at(-1)!.toLowerCase();
  if (/\.(?:tfstate|tfvars)(?:\.|$)/.test(basename)) return false;
  return sourceTextBasenames.some((name) => name.toLowerCase() === basename) || sourceTextExtensions.some((extension) => basename.endsWith(`.${extension}`));
}

export function reviewPathProblem(paths: readonly string[]): string | null {
  if (paths.some((path) => !isSupportedReviewPath(path))) return 'Use supported relative text-source paths; credential files and path traversal are not accepted.';
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) return 'Source paths must be unique. Add their relative project folders to distinguish duplicate filenames.';
  return null;
}
