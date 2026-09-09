namespace CodeAtlas.Unsupported;

public sealed class Cyfriflyfr
{
    private readonly List<long> cofnodion = [];

    public void Cofnodi(long gwerth) => cofnodion.Add(gwerth);

    public long Cyfanswm() => cofnodion.Sum();
}

public static class Prosesydd
{
    public static long Prosesu(IEnumerable<long> gwerthoedd)
    {
        var llyfr = new Cyfriflyfr();
        foreach (var gwerth in gwerthoedd) llyfr.Cofnodi(gwerth);
        return llyfr.Cyfanswm();
    }
}
