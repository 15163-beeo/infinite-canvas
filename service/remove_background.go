package service

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/basketikun/infinite-canvas/config"
)

var (
	removeBackgroundWarmupOnce sync.Once
	removeBackgroundWorkerInst = &removeBackgroundWorker{}
)

type removeBackgroundWorker struct {
	mu     sync.Mutex
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	stderr *lockedBuffer
}

type removeBackgroundWorkerRequest struct {
	Input  string `json:"input"`
	Output string `json:"output"`
}

type removeBackgroundWorkerResponse struct {
	Ready bool   `json:"ready,omitempty"`
	OK    bool   `json:"ok,omitempty"`
	Error string `json:"error,omitempty"`
}

type lockedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (buf *lockedBuffer) Write(data []byte) (int, error) {
	buf.mu.Lock()
	defer buf.mu.Unlock()
	return buf.buffer.Write(data)
}

func (buf *lockedBuffer) String() string {
	buf.mu.Lock()
	defer buf.mu.Unlock()
	return buf.buffer.String()
}

func StartRemoveBackgroundWarmup() {
	removeBackgroundWarmupOnce.Do(func() {
		go func() {
			timeout := time.Duration(max(5, config.Cfg.RemoveBGTimeout)) * time.Second
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()
			if _, err := ensureRemoveBackgroundWorker(ctx); err != nil {
				log.Printf("remove background warmup failed: %v", err)
			}
		}()
	})
}

func RemoveBackground(ctx context.Context, filename string, contentType string, data []byte) ([]byte, error) {
	if len(data) == 0 {
		return nil, safeMessageError{message: "去背景图片不能为空"}
	}
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "image/") {
		return nil, safeMessageError{message: "去背景只支持图片文件"}
	}

	inputFile, err := os.CreateTemp("", "remove-bg-input-*"+imageExtByMime(contentType, filename))
	if err != nil {
		return nil, err
	}
	inputPath := inputFile.Name()
	defer os.Remove(inputPath)
	if _, err := inputFile.Write(data); err != nil {
		_ = inputFile.Close()
		return nil, err
	}
	if err := inputFile.Close(); err != nil {
		return nil, err
	}

	outputFile, err := os.CreateTemp("", "remove-bg-output-*.png")
	if err != nil {
		return nil, err
	}
	outputPath := outputFile.Name()
	_ = outputFile.Close()
	defer os.Remove(outputPath)

	if err := removeBackgroundWithWorker(ctx, inputPath, outputPath); err != nil {
		log.Printf("remove background worker failed, fallback to one-shot command: %v", err)
		if fallbackErr := runRemoveBackgroundCommand(ctx, inputPath, outputPath); fallbackErr != nil {
			return nil, fallbackErr
		}
	}

	result, err := os.ReadFile(outputPath)
	if err != nil {
		return nil, err
	}
	if len(result) == 0 {
		return nil, errors.New("去背景结果为空")
	}
	return result, nil
}

func removeBackgroundWithWorker(ctx context.Context, inputPath string, outputPath string) error {
	worker, err := ensureRemoveBackgroundWorker(ctx)
	if err != nil {
		return err
	}
	return worker.process(ctx, inputPath, outputPath)
}

func ensureRemoveBackgroundWorker(ctx context.Context) (*removeBackgroundWorker, error) {
	return removeBackgroundWorkerInst.ensure(ctx)
}

func (worker *removeBackgroundWorker) ensure(ctx context.Context) (*removeBackgroundWorker, error) {
	worker.mu.Lock()
	defer worker.mu.Unlock()
	if worker.cmd != nil && worker.stdin != nil && worker.stdout != nil {
		return worker, nil
	}
	if err := worker.startLocked(ctx); err != nil {
		return nil, err
	}
	return worker, nil
}

func (worker *removeBackgroundWorker) startLocked(ctx context.Context) error {
	scriptPath, err := removeBackgroundWorkerScriptPath()
	if err != nil {
		return err
	}

	stderr := &lockedBuffer{}
	args := []string{"-u", scriptPath, "--model", strings.TrimSpace(config.Cfg.RemoveBGModel)}
	cmd := exec.Command(strings.TrimSpace(config.Cfg.RemoveBGPython), args...)
	cmd.Dir = projectRoot()
	cmd.Env = append(
		os.Environ(),
		"PYTHONUNBUFFERED=1",
		"PYTHONPATH="+joinedPythonPath(resolveWorkspacePath(config.Cfg.RemoveBGPythonPath), os.Getenv("PYTHONPATH")),
	)
	cmd.Stderr = stderr

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return err
	}

	stdout := bufio.NewReader(stdoutPipe)
	response, err := readRemoveBackgroundWorkerResponse(ctx, stdout)
	if err != nil {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		go func() { _ = cmd.Wait() }()
		return normalizeRemoveBackgroundFailure(err, []byte(stderr.String()))
	}
	if !response.Ready {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		go func() { _ = cmd.Wait() }()
		return normalizeRemoveBackgroundFailure(errors.New("去背景 worker 未就绪"), []byte(response.Error+"\n"+stderr.String()))
	}

	worker.cmd = cmd
	worker.stdin = stdin
	worker.stdout = stdout
	worker.stderr = stderr

	go worker.watch(cmd)

	return nil
}

func (worker *removeBackgroundWorker) watch(command *exec.Cmd) {
	if err := command.Wait(); err != nil {
		log.Printf("remove background worker exited: %v", err)
	}
	worker.mu.Lock()
	defer worker.mu.Unlock()
	if worker.cmd == command {
		worker.stdin = nil
		worker.stdout = nil
		worker.cmd = nil
	}
}

func (worker *removeBackgroundWorker) process(ctx context.Context, inputPath string, outputPath string) error {
	worker.mu.Lock()
	defer worker.mu.Unlock()

	if worker.cmd == nil || worker.stdin == nil || worker.stdout == nil {
		return errors.New("去背景 worker 未启动")
	}

	payload, err := json.Marshal(removeBackgroundWorkerRequest{Input: inputPath, Output: outputPath})
	if err != nil {
		return err
	}
	if _, err := worker.stdin.Write(append(payload, '\n')); err != nil {
		worker.closeLocked()
		return normalizeRemoveBackgroundFailure(err, []byte(worker.stderrStringLocked()))
	}

	response, err := readRemoveBackgroundWorkerResponse(ctx, worker.stdout)
	if err != nil {
		worker.closeLocked()
		return normalizeRemoveBackgroundFailure(err, []byte(worker.stderrStringLocked()))
	}
	if response.OK {
		return nil
	}

	errOutput := response.Error
	if stderr := worker.stderrStringLocked(); strings.TrimSpace(stderr) != "" {
		errOutput = strings.TrimSpace(strings.Join([]string{errOutput, stderr}, "\n"))
	}
	if errOutput == "" {
		errOutput = "去背景 worker 返回异常"
	}
	return normalizeRemoveBackgroundFailure(errors.New(errOutput), []byte(errOutput))
}

func (worker *removeBackgroundWorker) stderrStringLocked() string {
	if worker.stderr == nil {
		return ""
	}
	return worker.stderr.String()
}

func (worker *removeBackgroundWorker) closeLocked() {
	if worker.stdin != nil {
		_ = worker.stdin.Close()
	}
	if worker.cmd != nil && worker.cmd.Process != nil {
		_ = worker.cmd.Process.Kill()
	}
	worker.stdin = nil
	worker.stdout = nil
	worker.cmd = nil
}

func readRemoveBackgroundWorkerResponse(ctx context.Context, reader *bufio.Reader) (removeBackgroundWorkerResponse, error) {
	type responseResult struct {
		line []byte
		err  error
	}

	resultCh := make(chan responseResult, 1)
	go func() {
		line, err := reader.ReadBytes('\n')
		resultCh <- responseResult{line: line, err: err}
	}()

	select {
	case <-ctx.Done():
		return removeBackgroundWorkerResponse{}, ctx.Err()
	case result := <-resultCh:
		if result.err != nil {
			return removeBackgroundWorkerResponse{}, result.err
		}
		line := bytes.TrimSpace(result.line)
		response := removeBackgroundWorkerResponse{}
		if err := json.Unmarshal(line, &response); err != nil {
			return response, fmt.Errorf("去背景 worker 响应解析失败: %w", err)
		}
		return response, nil
	}
}

func runRemoveBackgroundCommand(ctx context.Context, inputPath string, outputPath string) error {
	command, err := removeBackgroundCommand(ctx, inputPath, outputPath)
	if err != nil {
		return err
	}
	output, err := command.CombinedOutput()
	if err != nil {
		return normalizeRemoveBackgroundFailure(err, output)
	}
	return nil
}

func removeBackgroundCommand(ctx context.Context, inputPath string, outputPath string) (*exec.Cmd, error) {
	scriptPath, err := removeBackgroundScriptPath()
	if err != nil {
		return nil, err
	}
	args := []string{scriptPath, "--model", strings.TrimSpace(config.Cfg.RemoveBGModel), "--input", inputPath, "--output", outputPath}
	cmd := exec.CommandContext(ctx, strings.TrimSpace(config.Cfg.RemoveBGPython), args...)
	cmd.Dir = projectRoot()
	cmd.Env = append(os.Environ(), "PYTHONPATH="+joinedPythonPath(resolveWorkspacePath(config.Cfg.RemoveBGPythonPath), os.Getenv("PYTHONPATH")))
	return cmd, nil
}

func removeBackgroundScriptPath() (string, error) {
	path := resolveWorkspacePath("tools/remove_background.py")
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("去背景脚本不存在: %w", err)
	}
	return path, nil
}

func removeBackgroundWorkerScriptPath() (string, error) {
	path := resolveWorkspacePath("tools/remove_background_worker.py")
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("去背景 worker 脚本不存在: %w", err)
	}
	return path, nil
}

func resolveWorkspacePath(path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(projectRoot(), filepath.FromSlash(path))
}

func projectRoot() string {
	candidates := []string{}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, cwd)
	}
	if executable, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Dir(executable))
	}
	for _, candidate := range candidates {
		current := candidate
		for {
			if _, err := os.Stat(filepath.Join(current, "go.mod")); err == nil {
				return current
			}
			parent := filepath.Dir(current)
			if parent == current {
				break
			}
			current = parent
		}
	}
	return "."
}

func joinedPythonPath(primary string, current string) string {
	values := []string{}
	if strings.TrimSpace(primary) != "" {
		values = append(values, primary)
	}
	if strings.TrimSpace(current) != "" {
		values = append(values, current)
	}
	return strings.Join(values, string(os.PathListSeparator))
}

func imageExtByMime(contentType string, filename string) string {
	switch strings.ToLower(strings.TrimSpace(contentType)) {
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/bmp":
		return ".bmp"
	}
	ext := strings.ToLower(strings.TrimSpace(filepath.Ext(filename)))
	if ext == ".jpg" || ext == ".jpeg" || ext == ".png" || ext == ".webp" || ext == ".bmp" {
		return ext
	}
	return ".png"
}

func normalizeRemoveBackgroundFailure(commandErr error, output []byte) error {
	message := strings.TrimSpace(string(output))
	switch {
	case strings.Contains(message, "No module named 'rembg'"),
		strings.Contains(message, "No module named rembg"),
		strings.Contains(message, "ModuleNotFoundError"):
		return safeMessageError{message: "去背景依赖未安装，请先执行 `pip install -r tools/remove_background_requirements.txt -t .local/pydeps`"}
	case strings.Contains(message, "HTTPError"),
		strings.Contains(message, "Gateway Time-out"),
		strings.Contains(message, "Read timed out"):
		return safeMessageError{message: "去背景模型首次下载失败，请重试一次"}
	}
	if message == "" {
		message = commandErr.Error()
	}
	if len(message) > 400 {
		message = message[:400] + "..."
	}
	return safeMessageError{message: "去背景失败：" + message}
}
