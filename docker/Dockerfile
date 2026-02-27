FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    curl \
    unzip \
    bash \
    tmux \
    ripgrep \
    tini \
    sudo \
    ca-certificates \
    gnupg \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 (NodeSource)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI (official apt repo)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user with passwordless sudo
RUN adduser --disabled-password --gecos "" --shell /bin/bash devuser \
    && echo 'devuser ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# Bun (install first, use for remaining packages)
RUN curl -fsSL https://bun.com/install | bash \
    && mv /root/.bun/bin/bun /usr/local/bin/bun \
    && ln -s /usr/local/bin/bun /usr/local/bin/bunx \
    && rm -rf /root/.bun

# Codex, Gemini CLI, TypeScript (npm for reliable /usr/local/bin linking)
RUN npm install -g @openai/codex \
    && npm install -g @google/gemini-cli \
    && npm install -g typescript ts-node

# Claude Code: disable auto-updater in container
ENV DISABLE_AUTOUPDATER=1

# Claude Code (install as devuser so it lands in their home dir)
USER devuser
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/devuser/.local/bin:$PATH"

# Shell config (PATH + alias in .bashrc for interactive shells)
RUN echo 'export PATH="/home/devuser/.local/bin:$PATH"' >> /home/devuser/.bashrc \
    && echo 'alias claude="claude --dangerously-skip-permissions"' >> /home/devuser/.bashrc

# tmux config (mouse mode)
RUN echo 'set -g mouse on' >> /home/devuser/.tmux.conf

# Back to root for directory setup, then switch to devuser
USER root
RUN mkdir -p /app && chown devuser:devuser /app

USER devuser
WORKDIR /app

ENTRYPOINT ["tini", "--"]
CMD ["sleep", "infinity"]
