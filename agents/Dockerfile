# Python 3.12, deliberately NOT the newest release: opencv-python-headless often
# has no wheel for the latest CPython (3.14 on this repo's dev machine), which
# would force a source build needing CMake. 3.12 has wheels for everything here.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Requirements first so a source change does not reinstall dependencies.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY run_agent.py ./
COPY security_agent/ ./security_agent/

# Unprivileged: a collector agent needs no write access to anything.
RUN useradd --create-home --shell /bin/bash agent && chown -R agent:agent /app
USER agent

# Arguments come from each compose service's `command`, so one image serves every
# agent type.
ENTRYPOINT ["python", "run_agent.py"]
CMD ["--help"]
