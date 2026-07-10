using System.Runtime.InteropServices;

namespace EmailFinderTray;

internal static class WidgetDrag
{
    private const int WmNclButtonDown = 0xA1;
    private const int HtCaption = 0x2;

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

    public static void Enable(Form form, params Control[] controls)
    {
        void OnMouseDown(object? sender, MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left)
            {
                return;
            }

            if (sender is Control c && IsInteractiveOrChild(c))
            {
                return;
            }

            ReleaseCapture();
            SendMessage(form.Handle, WmNclButtonDown, HtCaption, 0);
        }

        form.MouseDown += OnMouseDown;
        foreach (var root in controls)
        {
            WireDrag(root, OnMouseDown);
        }
    }

    private static void WireDrag(Control control, MouseEventHandler handler)
    {
        if (IsInteractiveOrChild(control))
        {
            return;
        }

        control.MouseDown += handler;
        foreach (Control child in control.Controls)
        {
            WireDrag(child, handler);
        }
    }

    private static bool IsInteractiveOrChild(Control control)
    {
        for (var c = control; c != null; c = c.Parent)
        {
            if (c is TextBox or ComboBox or Button or LinkLabel or WidgetEmailRow)
            {
                return true;
            }
        }

        return false;
    }
}
