import { Command } from "commander"
import {
  SETTING_KEYS,
  defaultHome,
  describeSettings,
  dirOf,
  envVarFor,
  getSetting,
  profileOf,
  readSettings,
  readSettingsFile,
  setSetting,
  settingsPath,
  writeSettingsFile,
  type SettingKey,
} from "../config.ts"
import { fail, print, table } from "../output.ts"

const isKey = (key: string): key is SettingKey => (SETTING_KEYS as readonly string[]).includes(key)

/** The home, profile and profile directory a config command acts on. */
function target(cmd: Command) {
  const opts = cmd.optsWithGlobals<{ home?: string; profile?: string }>()
  const home = opts.home ?? defaultHome()
  const profile = profileOf(home, opts.profile)
  return { home, profile, dir: dirOf(profile), profileFlag: opts.profile }
}

export function configCommand(): Command {
  const cmd = new Command("config").description(
    "settings: the profile in use, and per network the node, L1 RPC, addresses, defaults",
  )

  cmd
    .command("show")
    .description("every setting, the value in force, and where it comes from")
    .action((_opts: unknown, cmd: Command) => {
      const { home, dir, profileFlag } = target(cmd)
      const rows = describeSettings(readSettings(home, dir), profileFlag).map(
        ({ key, value, source }) => [
          key,
          key === "node.apiKey" && value
            ? "set"
            : (value ?? (key === "profile" ? "mainnet" : "from profile")),
          source === "flag"
            ? "flag --profile"
            : source === "env"
              ? `env ${envVarFor(key)}`
              : source === "file"
                ? "config file"
                : key === "profile" && !value
                  ? "default"
                  : "profile",
        ],
      )
      print(table(rows, ["setting", "value", "source"]))
      print(`\nFiles: ${settingsPath(home)} (profile), ${settingsPath(home, dir)} (${dir})`)
    })

  cmd
    .command("set <key> <value>")
    .description("pin a setting: profile for the home, anything else for the current network")
    .action((key: string, value: string, _opts: unknown, cmd: Command) => {
      if (!isKey(key)) fail(`unknown setting "${key}"`, `one of: ${SETTING_KEYS.join(", ")}`)
      const { home, dir } = target(cmd)
      const path = key === "profile" ? settingsPath(home) : settingsPath(home, dir)
      writeSettingsFile(path, setSetting(readSettingsFile(path), key, value))
      print(
        `${key} = ${key === "node.apiKey" ? "(set)" : value}${
          key === "profile" ? "" : ` for ${dir}`
        }`,
      )
    })

  cmd
    .command("unset <key>")
    .description("remove a pinned setting so the profile's value applies again")
    .action((key: string, _opts: unknown, cmd: Command) => {
      if (!isKey(key)) fail(`unknown setting "${key}"`, `one of: ${SETTING_KEYS.join(", ")}`)
      const { home, dir } = target(cmd)
      // A value in the home's file reaches every network, so clearing it for one clears it there too.
      const paths =
        key === "profile" ? [settingsPath(home)] : [settingsPath(home, dir), settingsPath(home)]
      for (const path of paths) {
        const settings = readSettingsFile(path)
        if (getSetting(settings, key) !== undefined)
          writeSettingsFile(path, setSetting(settings, key, undefined))
      }
      print(`${key} cleared${key === "profile" ? "" : ` for ${dir}`}`)
    })

  return cmd
}
