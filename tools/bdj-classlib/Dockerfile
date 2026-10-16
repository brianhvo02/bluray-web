# Build environment for the trimmed OpenJDK 8 class library. It extends the trace image, so the JDK, the apt snapshot
# and libbluray's Java jars are exactly the ones the trace harness uses.
FROM bluray-web-bdj-trace

RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends zip unzip \
 && rm -rf /var/lib/apt/lists/*
