# Build environment for the libass trace harness. Pinned: ubuntu 24.04 by digest, libass by commit (tag 0.17.5).
FROM ubuntu@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential meson ninja-build pkg-config git ca-certificates patch \
    libfreetype-dev libharfbuzz-dev libfribidi-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --quiet https://github.com/libass/libass.git /src/libass \
 && cd /src/libass \
 && git checkout --quiet 4a05d8127f525943ebf45fdc6497c9e665947f0d

COPY trace.patch /src/trace.patch
RUN cd /src/libass && patch -p1 < /src/trace.patch

# No fontconfig, no libunibreak (line breaks only at spaces, as in most ffmpeg builds), no asm.
RUN cd /src/libass \
 && meson setup build --buildtype=release --default-library=static --prefix=/usr/local \
      -Dfontconfig=disabled -Ddirectwrite=disabled -Dcoretext=disabled -Drequire-system-font-provider=false \
      -Dasm=disabled -Dlibunibreak=disabled -Dtest=disabled \
 && ninja -C build && ninja -C build install

COPY ass_trace.c /src/ass_trace.c
RUN gcc -O1 -Wall -Wextra -Werror /src/ass_trace.c -o /usr/local/bin/ass_trace \
      $(PKG_CONFIG_PATH=/usr/local/lib/pkgconfig:/usr/local/lib/x86_64-linux-gnu/pkgconfig:/usr/local/lib/aarch64-linux-gnu/pkgconfig pkg-config --static --cflags --libs libass) -lz -lm
