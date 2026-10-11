# Arhaty Claude Code plugins

[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/arhaty/claude-plugins/badge)](https://scorecard.dev/viewer/?uri=github.com/arhaty/claude-plugins)

A Claude Code plugin marketplace. Add it once, then install the plugins you want:

```text
/plugin marketplace add arhaty/claude-plugins
/plugin install <plugin>@arhaty
```

| Plugin                  | What it does                                                                                                                                | Install                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| [canon](plugins/canon/) | A spec, build, review, canon workflow: specs plan the work, `docs/canon/` records how the project works today, hooks enforce the git rules. | `/plugin install canon@arhaty` |

Before installing canon, check its [prerequisites](plugins/canon/README.md#prerequisites) and
[limitations](plugins/canon/README.md#limitations).

Each plugin has its own README, version and changelog. Releases are tagged per plugin
(`canon-v0.1.0`).

## Updating

```text
/plugin marketplace update arhaty
/plugin update <plugin>@arhaty
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
