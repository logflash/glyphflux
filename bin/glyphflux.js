#!/usr/bin/env node

import { runGlyphfluxCli } from '../dist/cli.mjs'

process.exitCode = await runGlyphfluxCli()
