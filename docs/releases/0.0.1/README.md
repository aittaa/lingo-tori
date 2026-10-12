# 0.0.1 baseline records

The independent version baseline incorporates source already present at main commit `d1bba610634c7000dd930743f39948274e743271` (tree `ce859c581cb2c05f3aa41fe78c8ca761d7c34949`). The 37 Markdown records in [changesets](changesets/) were moved byte-for-byte from that snapshot's `.changeset/` directory. They retain their original wording and historical verification limits; they are neither new release requests nor a claim that every described capability is currently supported.

Five records originated upstream before the fork: `keep-translations-across-identical-rewrites.md`, `layout-editor-field-pills.md`, `quiet-fields-keep-context.md`, `selection-toolbar-action-shortcuts.md`, and `tiny-frogs-read-code.md`. The other 32 record independent fork work already in the pinned snapshot. Their Git history and the upstream changelog preserve authorship. Original minor/patch headers are retained as historical data outside the active changeset directory.

Archiving the complete baseline avoids scheduling its three minor and 34 patch records again. New work after this snapshot belongs in `.changeset/` and is not part of this archive. Do not move later concurrent work into the archive merely because it merges before this reset. See [version and installation notes](../../versioning.md) for build receipts and downgrade considerations.
