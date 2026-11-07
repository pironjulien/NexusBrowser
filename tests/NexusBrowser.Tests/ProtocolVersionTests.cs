using System.Text.Json.Nodes;
using NexusBrowser.Native;
using Xunit;

namespace NexusBrowser.Tests;

/// <summary>MCP lifecycle: initialize answers with a version this server supports, never an unknown one echoed back.</summary>
public sealed class ProtocolVersionTests
{
    [Theory]
    [InlineData("2024-11-05")]
    [InlineData("2025-03-26")]
    [InlineData("2025-06-18")]
    [InlineData("2025-11-25")]
    public void SupportedVersionIsKept(string version) =>
        Assert.Equal(version, McpServer.NegotiateProtocolVersion(JsonValue.Create(version)));

    [Theory]
    [InlineData("2099-01-01")]
    [InlineData("2026-07-28")] // stateless: server/discover, not initialize
    [InlineData("")]
    public void UnsupportedVersionGetsTheLatestSupported(string version) =>
        Assert.Equal("2025-11-25", McpServer.NegotiateProtocolVersion(JsonValue.Create(version)));

    [Fact]
    public void NonStringVersionGetsTheLatestSupported() =>
        Assert.Equal("2025-11-25", McpServer.NegotiateProtocolVersion(JsonValue.Create(42)));

    [Fact]
    public void MissingVersionKeepsTheDefault() =>
        Assert.Equal(McpServer.DefaultProtocolVersion, McpServer.NegotiateProtocolVersion(null));
}
