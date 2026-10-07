Video Playlist Control (VPC)
===============================
Video Playlist Control (VPC) is a dual-monitor video playout application built with Tauri, Rust, and standard web technologies. Designed for live events and presentations, it provides a reliable interface to manage video playlists, preview upcoming clips, and trigger seamless transitions (CUT) to an external viewer.

Features
- Dual Monitor Output: Control your playlist on the main screen while outputting the Program video to a secondary screen.
- Preview & Program: Monitor the currently playing video and the next video in the queue simultaneously.
- Instant Transitions: Trigger hard cuts or use the Auto/Delay features for automated playout.
- Metadata Extraction: Automatically reads video duration, resolution, and detects 4K, HEVC, and HDR formats.
- Audio VU-Meters: Custum made real-time stereo audio meters for both Preview and Program monitors.
- Customizable: Supports multiple languages (English, French, Italian and more to come), some keyboard shortcuts, and UI preferences.
- Cross-Platform: Native builds for Windows and macOS (Linux build is coming).

Dependencies & Licensing
VPC uses two open-source companion tools to handle video playback and metadata extraction:
- MPV
	Used as the external video viewer.
	Available under the GPL-2.0 and LGPL-2.1 licenses.
- FFmpeg / FFprobe
	Used to extract video metadata (duration, resolution, codec etc...).
	Available under the GPL-2.0 & GPL-3.0 and LGPL-2.1 & LGPL-3.0 licenses.
Video Playlist Control itself is licensed under the GPL-3.0 license.

macOS Installation Guide (Quarantine Fix)
macOS Gatekeeper may block VPC from running (Quarantine), considering it as an "unidentified developers."
Open your Terminal and run the following command to remove the quarantine attribute:
xattr -cr /Applications/VideoPlaylistControl.app
(Adjust the path if you placed the app elsewhere).

For instructions on how to compile the application from source, please refer to the "How to compile.txt" file included in this repository.
