using System.Text.RegularExpressions;

namespace EmailFinderTray;

/// <summary>One selectable email template - mirrors lib/email-templates.ts on the web.</summary>
internal sealed record WidgetEmailTemplate(string Id, string Label, string Subject, string Body);

internal static class WidgetMailTemplates
{
    public const string DefaultSubject = "Collaboration suggestion";

    public const string DefaultBody = """
        Hi {{name}},
        Is this you, right?
        {{url}}
        I'm currently looking for one strong long-term collaborator to partner with on client projects - someone I can build with consistently, not just bring in as a contractor here and there.

        I wanted to reach out because I think this could be a strong fit for both of us.
        I'm a Web & AI Engineer with 10+ years of experience, and I've already worked this way with other developers on quality client work. It's been a very effective setup, and I'm now looking to build a similar long-term collaboration with the right person.

        The way I usually work is simple:

        I handle lead generation, proposals, project execution, and delivery.
        You remain the client-facing owner when needed, especially for calls or account-based communication.

        We can collaborate through your existing Upwork profile in a fully compliant subcontracting / agency-style setup, or work with direct remote clients outside platforms.
        In other words, I take care of the technical and operational side, and together we create a setup that's reliable, scalable, and beneficial for both of us.

        Revenue split would be:

        20% to you for projects done through your Upwork profile.
        50/50 for direct remote projects.

        Why this tends to work well:

        You keep control of your profile, client communication, and payments.
        There's no upfront risk for you.
        I focus on doing the actual work and helping increase project volume.
        I'm looking for a real long-term partnership, not a short-term deal.

        If this sounds like something you'd be open to, I'd love to have a quick chat and see if there's a fit.
        Telegram : @StackPilotAI   Email:  imagesatomic@gmail.com

        Best,
        Wael
        """;

    public const string RemoteTeamUpSubject = "Looking to Team Up on Remote Projects";

    public const string RemoteTeamUpBody = """
        Hey {{name}},

        Hope you're doing well.

        I found your profile through {{url}}.
        I'm Wael, a full stack developer working mostly on remote software projects.

        Right now I'm looking to connect with another developer to team up, hunt remote jobs together, and make money by landing projects together long term.

        I feel like there's a lot more opportunity when good developers work together instead of solo grinding all the time.

        If you're interested, let me know and we can chat more.

        Cheers,
        Wael
        """;

    /// <summary>Built-in fallbacks, used until the server list loads (and if
    /// the server is unreachable). Mirrors the web app's seed templates.</summary>
    public static readonly IReadOnlyList<WidgetEmailTemplate> BuiltIn =
    [
        new("collaboration", "Collaboration suggestion", DefaultSubject, DefaultBody),
        new("remote-teamup", "Remote team up", RemoteTeamUpSubject, RemoteTeamUpBody),
    ];

    /// <summary>Selectable templates, in display order. Starts as the built-in
    /// fallbacks; replaced by the app database's templates once fetched from
    /// /api/templates, so the widget always sends what Manage Templates saved.</summary>
    public static IReadOnlyList<WidgetEmailTemplate> All { get; private set; } = BuiltIn;

    /// <summary>Swap in the server-side template list (no-op when empty).</summary>
    public static void ApplyServerTemplates(IReadOnlyList<WidgetEmailTemplate> templates)
    {
        if (templates.Count > 0)
        {
            All = templates;
        }
    }

    public static WidgetEmailTemplate GetById(string? id) =>
        All.FirstOrDefault(t => string.Equals(t.Id, id, StringComparison.OrdinalIgnoreCase)) ?? All[0];

    public static string Substitute(string template, string name, string url)
    {
        var vars = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["name"] = string.IsNullOrWhiteSpace(name) ? "there" : name.Trim(),
            ["url"] = TrimUrlAtQuery(url.Trim()),
        };

        return Regex.Replace(
            template,
            @"\{\{\s*(\w+)\s*\}\}",
            m => vars.TryGetValue(m.Groups[1].Value, out var v) ? v : "");
    }

    public static string TrimUrlAtQuery(string url)
    {
        var q = url.IndexOf('?');
        return q >= 0 ? url[..q] : url;
    }

    public static bool IsValidEmail(string s) =>
        Regex.IsMatch(s, @"^[^\s@]+@[^\s@]+\.[^\s@]+$");
}
