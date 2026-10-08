package scripts

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// scriptEnv deliberately excludes caller credentials and shell startup hooks.
func scriptEnv(t *testing.T, prependPath ...string) []string {
	t.Helper()
	toolPaths := append([]string{}, prependPath...)
	for _, tool := range []string{"bash", "jq"} {
		resolved, err := exec.LookPath(tool)
		if err != nil {
			t.Fatalf("required test tool %s: %v", tool, err)
		}
		toolPaths = append(toolPaths, filepath.Dir(resolved))
	}
	toolPaths = append(toolPaths, "/usr/bin", "/bin")
	root := t.TempDir()
	return []string{"PATH=" + strings.Join(toolPaths, string(os.PathListSeparator)), "HOME=" + root, "TMPDIR=" + root, "XDG_CONFIG_HOME=" + filepath.Join(root, "config"), "LC_ALL=C", "TZ=UTC"}
}
