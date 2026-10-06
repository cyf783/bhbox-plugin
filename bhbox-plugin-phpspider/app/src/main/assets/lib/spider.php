<?php
/**
 * Copyright 道长所有
 * Date: 2026/01/23
 */
/**
 * PHP Spider Base Class
 * 旨在模仿 JS 版 TVBox Spider 的写法，简化 PHP 源开发
 *
 * T3 模式补丁：在 run() 方法中增加 ac=proxy 路由，
 * 支持 Java 侧 PhpSpider.proxyLocal() 调用。
 */

if (!headers_sent()) {
    header('Content-Type: application/json; charset=utf-8');
}
// 屏蔽一般警告，避免污染 JSON 输出
error_reporting(E_ALL);
ini_set('display_errors', '1');

require_once __DIR__ . '/HtmlParser.php';

abstract class BaseSpider {

    // 默认请求头
    protected $headers = [
        'User-Agent' => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept' => 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language' => 'zh-CN,zh;q=0.9',
    ];

    /**
     * @var HtmlParser
     */
    protected $htmlParser;

    public function __construct() {
        $this->htmlParser = new HtmlParser();
    }

    /**
     * 初始化方法
     * @param string $extend 扩展参数
     */
    public function init($extend = '') {
        // 子类实现
    }

    /**
     * 获取首页分类
     * @param array $filter 筛选条件
     * @return array
     */
    public function homeContent($filter) {
        return ['class' => []];
    }

    /**
     * 获取首页推荐视频
     * @return array
     */
    public function homeVideoContent() {
        return ['list' => []];
    }

    /**
     * 获取分类详情
     * @param string $tid 分类ID
     * @param int $pg 页码
     * @param array $filter 筛选条件
     * @param array $extend 扩展参数
     * @return array
     */
    public function categoryContent($tid, $pg = 1, $filter = [], $extend = []) {
        return ['list' => [], 'page' => $pg, 'pagecount' => 1, 'limit' => 20, 'total' => 0];
    }

    /**
     * 获取视频详情
     * @param array $ids 视频ID列表
     * @return array
     */
    public function detailContent($ids) {
        return ['list' => []];
    }

    /**
     * 搜索视频
     * @param string $key 关键词
     * @param bool $quick 快速搜索
     * @param int $pg 页码
     * @return array
     */
    public function searchContent($key, $quick = false, $pg = 1) {
        return ['list' => []];
    }

    /**
     * 获取播放地址
     * @param string $flag 播放线路
     * @param string $id 视频播放ID
     * @param array $vipFlags VIP标识
     * @return array
     */
    public function playerContent($flag, $id, $vipFlags = []) {
        return ['parse' => 0, 'url' => '', 'header' => []];
    }

    /**
     * 代理请求 (可选)
     * @param array $params
     * @return mixed 返回数组格式 [code, mime, body, headers?, base64?]
     *               或关联数组 ['code'=>200, 'mime'=>'...', 'body'=>'...', 'headers'=>[], 'base64'=>0]
     */
    public function localProxy($params) {
        return null;
    }

    /**
     * 执行 Action (可选)
     * @param string $action 动作名称
     * @param string $value 参数值
     * @return mixed
     */
    public function action($action, $value) {
        return '';
    }

    // ================== 辅助方法 ==================

    protected function pdfa($html, $rule) {
        return $this->htmlParser->pdfa($html, $rule);
    }

    protected function pdfh($html, $rule, $baseUrl = '') {
        return $this->htmlParser->pdfh($html, $rule, $baseUrl);
    }

    protected function pd($html, $rule, $baseUrl = '') {
        if (empty($baseUrl)) {
            $baseUrl = $this->tryGetHost();
        }
        return $this->htmlParser->pd($html, $rule, $baseUrl);
    }

    /**
     * 尝试获取子类定义的 HOST 常量或属性
     */
    private function tryGetHost() {
        try {
            $ref = new ReflectionClass($this);

            // 1. 尝试获取 HOST 属性 (优先)
            if ($ref->hasProperty('HOST')) {
                $prop = $ref->getProperty('HOST');
                if (PHP_VERSION_ID < 80100) {
                    $prop->setAccessible(true);
                }
                $val = $prop->getValue($this);
                if (!empty($val)) {
                    return $val;
                }
            }

            // 2. 尝试获取 const HOST 常量
            if ($ref->hasConstant('HOST')) {
                return $ref->getConstant('HOST');
            }
        } catch (Exception $e) {
            // ignore
        }
        return '';
    }

    /**
     * 快速构建分页返回结果
     * @param array $list 视频列表
     * @param int $pg 当前页码
     * @param int $total 总记录数 (可选)
     * @param int $limit 每页条数 (默认 20)
     * @return array
     */
    protected function pageResult($list, $pg, $total = 0, $limit = 20) {
        $pg = max(1, intval($pg));
        $count = count($list);

        if ($total > 0) {
            $pagecount = ceil($total / $limit);
        } else {
            if ($count < $limit) {
                $pagecount = $pg;
                $total = ($pg - 1) * $limit + $count;
            } else {
                $pagecount = 9999;
                $total = 99999;
            }
        }

        return [
            'list' => $list,
            'page' => $pg,
            'pagecount' => intval($pagecount),
            'limit' => intval($limit),
            'total' => intval($total)
        ];
    }

    /**
     * 封装 HTTP 请求
     * @param string $url 请求地址
     * @param array $options CURL 选项
     * @param array $headers 请求头
     * @return string|bool
     */
    protected function fetch($url, $options = [], $headers = []) {
        if (isset($options['headers'])) {
            $headers = array_merge($headers, $options['headers']);
            unset($options['headers']);
        }

        $ch = curl_init();

        $customHeaders = [];
        foreach ($headers as $k => $v) {
            if (is_numeric($k)) {
                $parts = explode(':', $v, 2);
                if (count($parts) === 2) {
                    $key = trim($parts[0]);
                    $value = trim($parts[1]);
                    $customHeaders[$key] = $value;
                }
            } else {
                $customHeaders[$k] = $v;
            }
        }

        $finalHeadersMap = array_merge($this->headers, $customHeaders);

        $mergedHeaders = [];
        foreach ($finalHeadersMap as $k => $v) {
            if ($v === "") {
                $mergedHeaders[] = $k . ";";
            } else {
                $mergedHeaders[] = "$k: $v";
            }
        }

        $defaultOptions = [
            CURLOPT_URL => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_SSL_VERIFYPEER => false,
            CURLOPT_SSL_VERIFYHOST => false,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_TIMEOUT => 15,
            CURLOPT_ENCODING => '',
            CURLOPT_HTTPHEADER => $mergedHeaders,
        ];

        if (isset($options['body'])) {
            $defaultOptions[CURLOPT_POST] = true;
            $defaultOptions[CURLOPT_POSTFIELDS] = $options['body'];
            unset($options['body']);
        }

        if (isset($options['cookie'])) {
            $defaultOptions[CURLOPT_COOKIE] = $options['cookie'];
            unset($options['cookie']);
        }

        foreach ($options as $k => $v) {
            $defaultOptions[$k] = $v;
        }

        curl_setopt_array($ch, $defaultOptions);
        $result = curl_exec($ch);

        if (is_resource($ch)) {
            curl_close($ch);
        }

        return $result;
    }

    protected function fetchJson($url, $options = []) {
        $resp = $this->fetch($url, $options);
        return json_decode($resp, true) ?: [];
    }

    /**
     * 自动运行，处理路由
     *
     * T3 模式增加 ac=proxy 路由，支持 Java 侧 PhpSpider.proxyLocal() 调用。
     */
    public function run() {
        $ac = $_GET['ac'] ?? '';
        $t = $_GET['t'] ?? '';
        $pg = $_GET['pg'] ?? '1';
        $wd = $_GET['wd'] ?? '';
        $ids = $_GET['ids'] ?? '';
        $play = $_GET['play'] ?? '';
        $flag = $_GET['flag'] ?? '';
        $filter = isset($_GET['filter']) && $_GET['filter'] === 'true';
        $extend = $_GET['ext'] ?? '';
        if (!empty($extend) && is_string($extend)) {
            $decoded = json_decode(base64_decode($extend), true);
            if (is_array($decoded)) {
                $extend = $decoded;
            }
        }
        $action = $_GET['action'] ?? '';
        $value = $_GET['value'] ?? '';

        $this->init($extend);

        try {
            // 0. 代理 (localProxy) — T3 模式专用
            if ($ac === 'proxy') {
                $body = file_get_contents('php://input');
                $proxyParams = json_decode($body, true);
                if (!is_array($proxyParams)) {
                    $proxyParams = $_GET;
                }
                $result = $this->localProxy($proxyParams);
                if ($result === null) {
                    http_response_code(404);
                    echo json_encode(['code' => 404, 'mime' => 'text/plain', 'body' => 'Not Found', 'headers' => [], 'base64' => 0]);
                    return;
                }
                // localProxy 返回数组格式：[code, mime, body, headers?, base64?]
                if (is_array($result) && isset($result[0])) {
                    $proxyResult = [
                        'code' => $result[0] ?? 200,
                        'mime' => $result[1] ?? 'application/octet-stream',
                        'body' => $result[2] ?? '',
                        'headers' => $result[3] ?? [],
                        'base64' => $result[4] ?? 0,
                    ];
                } elseif (is_array($result) && isset($result['code'])) {
                    $proxyResult = $result;
                } else {
                    $proxyResult = ['code' => 200, 'mime' => 'text/plain', 'body' => '', 'headers' => [], 'base64' => 0];
                }
                header('Content-Type: application/json; charset=utf-8');
                echo json_encode($proxyResult, JSON_UNESCAPED_UNICODE);
                return;
            }

            // 1. Action (优先处理)
            if ($ac === 'action') {
                echo json_encode($this->action($action, $value), JSON_UNESCAPED_UNICODE);
                return;
            }

            // 2. 播放 (Play)
            if ($ac === 'play' || !empty($play)) {
                $playId = !empty($play) ? $play : ($_GET['id'] ?? '');
                echo json_encode($this->playerContent($flag, $playId), JSON_UNESCAPED_UNICODE);
                return;
            }

            // 3. 搜索 (Search)
            if (!empty($wd)) {
                echo json_encode($this->searchContent($wd, false, $pg), JSON_UNESCAPED_UNICODE);
                return;
            }

            // 4. 详情 (Detail)
            if (!empty($ids) && !empty($ac)) {
                $idList = explode(',', $ids);
                echo json_encode($this->detailContent($idList), JSON_UNESCAPED_UNICODE);
                return;
            }

            // 5. 分类 (Category)
            if ($t !== '' && !empty($ac)) {
                $filterData = [];
                echo json_encode($this->categoryContent($t, $pg, $filterData, $extend), JSON_UNESCAPED_UNICODE);
                return;
            }

            // 6. 首页 (默认)
            $homeData = $this->homeContent($filter);
            $videoData = $this->homeVideoContent();

            $result = [
                'class' => $homeData['class'] ?? [],
            ];

            if (isset($videoData['list'])) {
                $result['list'] = $videoData['list'];
            }
            if (isset($homeData['list']) && !empty($homeData['list'])) {
                $result['list'] = $homeData['list'];
            }
            if (isset($homeData['filters'])) {
                $result['filters'] = $homeData['filters'];
            }

            echo json_encode($result, JSON_UNESCAPED_UNICODE);

        } catch (Exception $e) {
            echo json_encode(['code' => 500, 'msg' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
        } catch (Throwable $e) {
            echo json_encode(['code' => 500, 'msg' => $e->getMessage()], JSON_UNESCAPED_UNICODE);
        }
    }
}
