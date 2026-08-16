# dsh-profile

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) profile built from scratch, plus a custom plugin.

Everything lives in this directory — `dsh.sh` points `DSH_HOME` here, so nothing
touches `~/.dsh`.

## Layout

```
dsh.sh                          run dsh against ./home
home/                           DSH_HOME (only profile source is tracked)
  profiles/loganz2/
    package.json                which bundles to stack — currently none
    cordis.patch.yml            the plugin list; the file you edit
plugins/shout/                  a custom plugin, TypeScript
```

## Use

```sh
./dsh.sh --dump-config      # print the composed plugin tree
./dsh.sh "some task"        # boot the profile
```

## How a profile works

`cordis.yml` is an empty list. The running tree is composed as ordered patch
layers over that emptiness:

```
bundles in package.json  →  cordis.patch.yml  →  --patch overlays
```

`bundles: []` means nothing is stacked, so the tree contains exactly what
`cordis.patch.yml` inserts. Add `@deepseek-ai/dsh-base` to `bundles` to get the
usual 78-row harness and patch it from there.

## Notes

`home/` is a DSH_HOME, so dsh writes credentials, settings, and session
transcripts into it at runtime. `.gitignore` excludes all of those — only the
profile source is tracked.
