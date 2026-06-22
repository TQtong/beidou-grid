// ============================================================
// GridFieldShaders.ts — 统一实例化立方体场的 GLSL 着色器（渲染 + 拾取）
// 层级：L1（渲染核心，仅依赖 GLSL 字符串，无运行时依赖）
// 职责：集中产出 GridCubeField 使用的四段着色器源码——
//       ① 渲染 VS：从 gl_InstanceID 反解 (i,j,zi) → 局部 ENU 米 → czm 投影；
//          同时按实例号采样「状态纹理」得类别，再用类别查「调色板纹理」得 RGBA。
//       ② 渲染 FS：全局不透明度调制 + 预乘 alpha + 透明类别 discard。
//       ③ 拾取 VS：与渲染共用同一套位置反解，但用 CPU 端自算的 u_mvp 投影
//          （避免手动 execute 离屏渲染时 czm 自动矩阵不同步），并以 flat 方式
//          把「实例号 + 1」编码进颜色。
//       ④ 拾取 FS：直接输出 flat 编码颜色（回读后解码得被点中的实例号）。
// 设计要点：
//   - 北斗网格高度规整：cell(i,j,zi) 的位置 = 区域原点 + 索引×步长，可完全由
//     gl_InstanceID 推出，故顶点缓冲只需一份「单位盒 8 角」，零逐实例位置上传。
//   - 单位盒角分量取 {0,1}（非 ±0.5）：第 i 格沿东向覆盖 [i·dimX,(i+1)·dimX]，
//     与 cellCenter=(i+0.5)·dimX 自洽。
//   - 精度：command.modelMatrix = 区域原点 ENU→ECEF 帧；VS 在「相对原点的局部米」
//     （小数值）计算，float32 精度充足，规避绝对 ECEF 大坐标抖动。
//   - WebGL2 / GLSL ES 3.00：使用 in/out、texture()、out_FragColor、gl_InstanceID、
//     整数运算与位运算（与本项目 Cesium 版本一致，已在 Xt3d 参考与现有 Primitive 验证）。
// 被消费：GridCubeField。
// ============================================================

/**
 * 共享「声明段」：单位盒角属性 + 由 gl_InstanceID 反解位置所需的整数/浮点 uniform。
 * 渲染与拾取两条管线都以此为位置计算的输入契约。
 */
const COMMON_POSITION_DECLS = /* glsl */ `
in vec3 position;        // 单位盒角，分量 ∈ {0,1}（8 个角点）
uniform int u_nx;        // 经向格数（列）
uniform int u_ny;        // 纬向格数（行）
uniform float u_dimX;    // 单格东向米宽（= stepLon° × 每度米 × cos(lat)）
uniform float u_dimY;    // 单格北向米高（= stepLat° × 每度米）
uniform float u_dimZ;    // 单格垂向米高（= heightStep）
`;

/**
 * 共享「位置反解段」：把 gl_InstanceID 拆为 (i,j,zi)，再算出该角点在
 * 「区域原点 ENU 局部坐标系」中的米坐标 localMeters。
 *
 * 反解：id = (zi·ny + j)·nx + i
 *   zi  = id / (nx·ny)
 *   rem = id − zi·(nx·ny)
 *   j   = rem / nx
 *   i   = rem − j·nx
 * 角点偏移：第 i 格东向区间 [i·dimX,(i+1)·dimX]，position.x∈{0,1} 选两端。
 *
 * 执行后产生：int gid（实例号）、ivec3(i,j,zi)、vec3 localMeters。
 */
const COMMON_POSITION_BODY = /* glsl */ `
  int gid = gl_InstanceID;
  int nxny = u_nx * u_ny;
  int zi = gid / nxny;
  int rem = gid - zi * nxny;
  int j = rem / u_nx;
  int i = rem - j * u_nx;
  vec3 localMeters = vec3(
    (float(i) + position.x) * u_dimX,
    (float(j) + position.y) * u_dimY,
    (float(zi) + position.z) * u_dimZ
  );
`;

/**
 * 渲染顶点着色器源码。
 *
 * 在共享位置反解之上：
 *  - 按实例号映射到「状态纹理」的纹素 (tx,ty)，采样 R 通道还原类别 cat∈[0,255]；
 *  - 用 cat 在 256×1「调色板纹理」上查得该类别的 RGBA（直存色，未预乘）；
 *  - gl_Position 用 czm_modelViewProjection（Cesium 渲染主链会用 command.modelMatrix
 *    刷新 czm 自动矩阵）投影局部米坐标。
 */
export const RENDER_VERTEX_SHADER = /* glsl */ `
${COMMON_POSITION_DECLS}
uniform sampler2D u_stateTex;   // 状态纹理（RGBA8，类别存于 R 通道，按实例号行优先排布）
uniform sampler2D u_palette;    // 调色板纹理（256×1 RGBA8，类别 → 颜色）
uniform int u_texW;             // 状态纹理宽
uniform int u_texH;             // 状态纹理高

out vec4 v_color;               // 传给 FS 的直存色（含 alpha）

void main() {
${COMMON_POSITION_BODY}

  // 实例号 → 状态纹理纹素（行优先，与 CPU 端 texData 写入顺序一致）。
  int tx = gid - (gid / u_texW) * u_texW;   // gid % texW
  int ty = gid / u_texW;                     // gid / texW
  vec2 stUv = (vec2(float(tx), float(ty)) + 0.5) / vec2(float(u_texW), float(u_texH));
  float catN = texture(u_stateTex, stUv).r;  // 归一化 0..1
  float cat = floor(catN * 255.0 + 0.5);     // 还原到整数类别 0..255

  // 类别 → 调色板颜色（NEAREST 采样，取类别列中心）。
  vec2 palUv = vec2((cat + 0.5) / 256.0, 0.5);
  v_color = texture(u_palette, palUv);

  gl_Position = czm_modelViewProjection * vec4(localMeters, 1.0);
}
`;

/**
 * 渲染片元着色器源码。
 *
 *  - u_opacity：全局不透明度系数（填充模式可调；线框恒为 1，由 uniformMap 决定）；
 *  - 透明类别（α≈0）直接 discard，避免写入无意义片元；
 *  - 预乘 alpha 输出，匹配 Cesium TRANSLUCENT 通道的「预乘 over」混合方程。
 */
export const RENDER_FRAGMENT_SHADER = /* glsl */ `
in vec4 v_color;
uniform float u_opacity;

void main() {
  vec4 c = v_color;
  c.a *= u_opacity;
  // 完全透明类别（未使用的 palette 槽）剔除，省混合带宽。
  if (c.a <= 0.0031) {  // ≈ 0.8/255，低于此视为不可见
    discard;
  }
  c.rgb *= c.a;         // 预乘（src=ONE, dst=ONE_MINUS_SRC_ALPHA）
  out_FragColor = c;
}
`;

/**
 * 拾取顶点着色器源码。
 *
 *  - 复用共享位置反解；
 *  - 用 CPU 端预乘好的 u_mvp（proj·view·model）投影，避免「手动 execute 离屏命令」
 *    时 czm_modelViewProjection 因未走主渲染链而取到过期 model 矩阵；
 *  - 以 flat 限定符把「实例号 + 1」拆成 RGB 三字节（+1 使 0 留给背景）。
 */
export const PICK_VERTEX_SHADER = /* glsl */ `
${COMMON_POSITION_DECLS}
uniform mat4 u_mvp;             // CPU 端自算的 投影·视图·模型 矩阵

flat out vec3 v_pickColor;      // 编码后的拾取色（逐实例恒定）

void main() {
${COMMON_POSITION_BODY}

  int idp = gid + 1;            // +1：让背景（清屏 0）与实例 0 区分
  int r = idp & 0xFF;
  int g = (idp >> 8) & 0xFF;
  int b = (idp >> 16) & 0xFF;   // 支持到 ~1600 万实例，远超预算
  v_pickColor = vec3(float(r), float(g), float(b)) / 255.0;

  gl_Position = u_mvp * vec4(localMeters, 1.0);
}
`;

/**
 * 拾取片元着色器源码：直接输出 flat 编码色（A=1），供离屏回读解码实例号。
 */
export const PICK_FRAGMENT_SHADER = /* glsl */ `
flat in vec3 v_pickColor;

void main() {
  out_FragColor = vec4(v_pickColor, 1.0);
}
`;

/**
 * 渲染/拾取共用的顶点属性位置绑定（仅一个属性：单位盒角 position）。
 * 位置数据完全由 gl_InstanceID 推导，故无任何逐实例属性。
 */
export const ATTRIBUTE_LOCATIONS: Readonly<Record<string, number>> = {
  position: 0,
} as const;
