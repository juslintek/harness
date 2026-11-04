//! Hand-written externs for the vendored libzstd. Segments are written with libzstd at level 3 and
//! read back with it too, because the raw length in the segments row is all ZSTD_decompress needs
//! (std.compress.zstd also needs a window buffer sized for the frame).
const std = @import("std");

pub extern fn ZSTD_compress(dst: [*]u8, dst_capacity: usize, src: [*]const u8, src_size: usize, level: c_int) usize;
pub extern fn ZSTD_decompress(dst: [*]u8, dst_capacity: usize, src: [*]const u8, compressed_size: usize) usize;
pub extern fn ZSTD_compressBound(src_size: usize) usize;
pub extern fn ZSTD_isError(code: usize) c_uint;
pub extern fn ZSTD_getErrorName(code: usize) [*:0]const u8;

test "logs/zstd_c: libzstd output decodes with std" {
    const gpa = std.testing.allocator;
    const src = try gpa.alloc(u8, 64 * 1024);
    defer gpa.free(src);
    for (src, 0..) |*byte, i| byte.* = @intCast('a' + (i * 7 % 13));

    const dst = try gpa.alloc(u8, ZSTD_compressBound(src.len));
    defer gpa.free(dst);
    const n = ZSTD_compress(dst.ptr, dst.len, src.ptr, src.len, 3);
    try std.testing.expectEqual(@as(c_uint, 0), ZSTD_isError(n));

    var in: std.Io.Reader = .fixed(dst[0..n]);
    var out: std.Io.Writer.Allocating = .init(gpa);
    defer out.deinit();
    const window: u32 = 1 << 20;
    const buf = try gpa.alloc(u8, window + std.compress.zstd.block_size_max);
    defer gpa.free(buf);
    var decoder = std.compress.zstd.Decompress.init(&in, buf, .{ .window_len = window });
    _ = try decoder.reader.streamRemaining(&out.writer);
    try std.testing.expectEqualSlices(u8, src, out.written());
}
