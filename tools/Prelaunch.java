import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// Prism pre-launch: run the packwiz update, then copy the shared CombatRadar
// ally/enemy lists (combatradar/players.json) into the member's own config.json,
// leaving every other radar setting alone.
public class Prelaunch {
    static final String[] KEYS = {"allyPlayers", "enemyPlayers"};

    public static void main(String[] args) throws Exception {
        Path mc = Paths.get(Prelaunch.class.getProtectionDomain().getCodeSource().getLocation().toURI()).getParent();
        if (args.length > 0) {
            String java = Paths.get(System.getProperty("java.home"), "bin", "java").toString();
            int code = new ProcessBuilder(java, "-jar", mc.resolve("packwiz-installer-bootstrap.jar").toString(), args[0])
                    .directory(mc.toFile()).inheritIO().start().waitFor();
            if (code != 0) System.exit(code); // "Quit" in the packwiz window cancels the launch
        }
        try {
            mergeLists(mc.resolve("combatradar"));
        } catch (Exception e) {
            System.err.println("CombatRadar lists not updated: " + e); // never block the game over this
        }
    }

    static void mergeLists(Path dir) throws IOException {
        Path cfg = dir.resolve("config.json"), lists = dir.resolve("players.json");
        if (!Files.exists(cfg) || !Files.exists(lists)) return;
        String config = new String(Files.readAllBytes(cfg), StandardCharsets.UTF_8);
        String shared = new String(Files.readAllBytes(lists), StandardCharsets.UTF_8);
        String out = config;
        for (String key : KEYS) {
            // ponytail: regex over the array, fine because Minecraft names can't contain ']' or quotes
            Pattern p = Pattern.compile("\"" + key + "\"\\s*:\\s*\\[[^\\]]*\\]");
            Matcher src = p.matcher(shared), dst = p.matcher(out);
            if (src.find() && dst.find()) out = out.substring(0, dst.start()) + src.group() + out.substring(dst.end());
        }
        if (!out.equals(config)) Files.write(cfg, out.getBytes(StandardCharsets.UTF_8));
    }
}
