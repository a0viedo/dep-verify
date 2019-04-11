# dep-verify


Tool to verify your dependencies. 

## Example
You can verify your npm's lockfile running the following command:

```
$ npx dep-verify --package-lock package-lock.json --log-level info --temp-dir /tmp | npx pino-pretty -c -l
```