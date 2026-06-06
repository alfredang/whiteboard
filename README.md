<div align="center">

# Whiteboard

[![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat&logo=html5&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/HTML)
[![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=flat&logo=css3&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/CSS)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![jsPDF](https://img.shields.io/badge/jsPDF-3.0-orange)](https://github.com/parallax/jsPDF)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![GitHub Pages](https://img.shields.io/badge/Deploy-GitHub%20Pages-222?logo=github)](https://alfredang.github.io/whiteboard/)

**A minimal, browser-based whiteboard with freehand drawing and flowchart tools, in a dark creative-studio aesthetic. Built for educators and trainers.**

[Live Demo](https://alfredang.github.io/whiteboard/) · [Report Bug](https://github.com/alfredang/whiteboard/issues) · [Request Feature](https://github.com/alfredang/whiteboard/issues)

</div>

## Screenshot

![Whiteboard Screenshot](preview.png)

## About

Whiteboard is a lightweight, zero-dependency drawing application designed for classroom and training environments. It runs entirely in the browser with no backend or build step required — just open `index.html` and start drawing. Beyond freehand sketching, it includes a set of flowchart tools so you can build labelled diagrams (process boxes, decisions, connectors) right on the board.

### Key Features

| Feature | Description |
|---------|-------------|
| **Freehand pen** | Smooth pressure-friendly drawing with a pencil cursor (`B`) |
| **Flowchart shapes** | Process box (`R`), rounded terminator (`G`), and decision diamond (`D`) — drag to size, then type a centered, auto-wrapped label |
| **Connector arrows** | Draw directional arrows to link shapes (`A`) |
| **Line & circle** | Straight lines (`I`) and ellipses (`O`) with live preview |
| **Eraser with size ring** | A circle cursor shows the exact eraser size as you erase (`E`) |
| **Lasso delete** | Encircle any region to wipe it in one stroke (`L`) |
| **Light / dark canvas** | Toggle between whiteboard and chalkboard modes (`T`) — existing work is inverted to match |
| **Multi-page support** | Add, delete, navigate, and reset pages with live thumbnail previews |
| **Color picker** | Full color selection with visual swatch indicator |
| **Adjustable size** | Per-tool size slider (pen 1–50px, eraser 5–120px) |
| **Undo** | Per-page undo history (Ctrl/Cmd+Z, up to 30 states) |
| **PDF export** | All pages exported as a single landscape PDF document |
| **Auto-save** | Pages persist to `localStorage` across refreshes |
| **Touch support** | Full touch input for tablets and mobile devices |
| **Responsive layout** | Adapts to any screen size with smooth animations |

## Tech Stack

| Category | Technology |
|----------|------------|
| **Markup** | HTML5 Canvas |
| **Styling** | CSS3 (custom properties, animations, responsive) |
| **Logic** | Vanilla JavaScript (ES6+) |
| **PDF Export** | [jsPDF 3.0](https://github.com/parallax/jsPDF) (CDN) |
| **Fonts** | [DM Sans](https://fonts.google.com/specimen/DM+Sans) + [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) |
| **Deployment** | GitHub Pages |

## Architecture

```
┌───────────────────────────────────────────────────────┐
│                        Browser                          │
│                                                         │
│  ┌──────────┐   ┌─────────────┐   ┌────────────┐        │
│  │  Header  │   │  Page Strip │   │ Status Bar │        │
│  │  Toolbar │   │  Thumbnails │   │  Coords    │        │
│  └────┬─────┘   └──────┬──────┘   └────────────┘        │
│       │                │                                │
│       ▼                ▼                                │
│  ┌──────────────────────────────────────────┐          │
│  │        HTML5 Canvas (1200×700)            │          │
│  │  ├── Freehand / Line / Circle             │          │
│  │  ├── Flowchart shapes + text labels       │          │
│  │  ├── Eraser (+ size ring) / Lasso delete  │          │
│  │  ├── Snapshot preview + Undo stack (×30)  │          │
│  │  └── Per-page state                       │          │
│  └───────┬───────────────────────┬───────────┘          │
│          │                       │                      │
│          ▼                       ▼                      │
│  ┌────────────────┐     ┌──────────────────┐            │
│  │  localStorage  │     │   jsPDF (CDN)    │            │
│  │  auto-save     │     │  multi-page PDF  │            │
│  └────────────────┘     └──────────────────┘            │
└───────────────────────────────────────────────────────┘
```

## Project Structure

```
whiteboard/
├── index.html          # Toolbar, canvas, page strip, status bar, text editor overlay
├── styles.css          # Dark/light themes, responsive layout, animations, cursors
├── whiteboard.js       # Drawing engine, shapes & labels, pages, undo, PDF export
├── preview.png         # Screenshot for README
└── README.md
```

## Getting Started

### Prerequisites

- Any modern web browser (Chrome, Firefox, Safari, Edge)

### Installation

```bash
git clone https://github.com/alfredang/whiteboard.git
cd whiteboard
```

### Usage

Open `index.html` directly in your browser, or serve it locally:

```bash
# Using Python
python3 -m http.server 8000

# Using Node.js
npx serve .
```

Then visit `http://localhost:8000`.

Or use the live version: **[https://alfredang.github.io/whiteboard/](https://alfredang.github.io/whiteboard/)**

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `B` | Pen |
| `E` | Eraser |
| `L` | Lasso delete |
| `I` | Line |
| `O` | Circle |
| `R` | Process box |
| `G` | Rounded box |
| `D` | Decision diamond |
| `A` | Connector arrow |
| `T` | Toggle light / dark canvas |
| `Ctrl/Cmd + Z` | Undo |
| `PgUp` / `Ctrl + ←` | Previous page |
| `PgDn` / `Ctrl + →` | Next page |

> **Tip:** After drawing a box, rounded box, or diamond, a text field appears inside it — type your label and press `Enter` (`Shift+Enter` for a new line, `Esc` to leave it blank).

## Deployment

This project is deployed to **GitHub Pages** directly from the `main` branch. No build step is needed — the site is served as static HTML.

To deploy your own fork:

1. Fork this repository
2. Go to **Settings > Pages**
3. Set source to `Deploy from a branch` → `main` → `/ (root)`
4. Your site will be live at `https://<your-username>.github.io/whiteboard/`

## Contributing

Contributions are welcome!

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

For questions or suggestions, use [GitHub Discussions](https://github.com/alfredang/whiteboard/discussions).

## Developed By

**Tertiary Infotech Academy Pte Ltd**

## Acknowledgements

- [jsPDF](https://github.com/parallax/jsPDF) — Client-side PDF generation
- [DM Sans](https://fonts.google.com/specimen/DM+Sans) & [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) — Typography
- [Google Fonts](https://fonts.google.com/) — Font delivery

## License

MIT

---

<div align="center">

If you found this useful, please consider giving it a star!

</div>
