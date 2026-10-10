#!/usr/bin/env bash
# Installs git, python3, Node.js 24, and MariaDB (provides the mysql client/server) on Debian/Ubuntu.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  SUDO="sudo"
else
  SUDO=""
fi

export DEBIAN_FRONTEND=noninteractive

$SUDO apt-get update -y
$SUDO apt-get install -y ca-certificates curl gnupg git python3 python3-pip python3-venv

# Node.js 24 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_24.x | $SUDO -E bash -
$SUDO apt-get install -y nodejs

# MariaDB server + client (MySQL-compatible; Oracle MySQL conflicts with MariaDB on the same host)
$SUDO apt-get install -y mariadb-server mariadb-client
$SUDO systemctl enable --now mariadb

echo "git:     $(git --version)"
echo "python3: $(python3 --version)"
echo "node:    $(node --version)"
echo "npm:     $(npm --version)"
echo "mariadb: $(mariadb --version)"
