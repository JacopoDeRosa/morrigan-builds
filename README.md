# Morrigan Labs builds

Demo builds from [Morrigan Labs](https://morriganlabs.com) for playtesting. Builds are temporary: each one deletes itself 24 hours after it goes up.

- **Newest build:** https://github.com/JacopoDeRosa/morrigan-builds/releases/latest
- **Everything that's up right now:** https://github.com/JacopoDeRosa/morrigan-builds/releases

## Downloading

Open a release and download the file under **Assets**. You don't need a GitHub account.

Builds of 2 GiB or more come in numbered parts (`.001`, `.002`, …) because GitHub caps release files at that size. Download every part into the same folder, then open the `.001` file with [7-Zip](https://www.7-zip.org/) to join them. The release notes also give a Command Prompt line that joins them without 7-Zip.

## Uploading

You need Node 18 or newer and the [GitHub CLI](https://cli.github.com) logged in with write access to this repo.

```
node tools/release.mjs upload <file-or-folder> [--name "Lumen demo"] [--notes "What changed"] [--hours 24 | --keep]
node tools/release.mjs list
node tools/release.mjs delete <tag>
node tools/release.mjs cleanup
```

- A folder gets zipped first. Unity's `*_BurstDebugInformation_DoNotShip` and `*_BackUpThisFolder_ButDontShipItWithYourGame` folders are left out.
- Files of 2 GiB or more get split into parts, with joining instructions in the release notes.
- `--hours` sets how long the build stays up. `--keep` keeps it until someone deletes it.

You can also publish a release from the GitHub website. It expires 24 hours after publishing, like the others. To keep it, put `<!-- expires: never -->` in its description.

## How builds expire

`upload` writes a hidden `<!-- expires: … -->` marker into each release's notes. The [Delete expired builds](.github/workflows/cleanup.yml) workflow runs twice an hour and deletes every release whose time is up, along with its tag. A build can outlast its expiry by about half an hour, or longer when GitHub's scheduler runs late. Each upload also clears out anything that has expired.

GitHub pauses scheduled workflows in public repos after 60 days without activity. Each upload switches the workflow back on.
